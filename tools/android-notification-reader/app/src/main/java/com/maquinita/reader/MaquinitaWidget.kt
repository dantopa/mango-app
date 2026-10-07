package com.maquinita.reader

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle

/**
 * The home-screen widget: this month's spending against the budget, the daily
 * allowance, and the last purchase, with an eye to hide the figures.
 *
 * Drawing never waits for the network. Every redraw — a tap on the eye, a resize,
 * a reboot — comes from the cached summary, and [WidgetRefresh] updates the cache
 * in the background. The receiver is not exported: the system reaches it as the
 * widget host, and its own PendingIntents carry the tap, so no other app can send
 * it a fake refresh or flip the privacy setting.
 */
class MaquinitaWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        draw(context, manager, appWidgetIds)
        // Idempotent: also re-establishes the schedule if an app update ever lost it.
        WidgetRefresh.schedule(context)
        WidgetRefresh.requestNow(context)
    }

    override fun onAppWidgetOptionsChanged(
        context: Context,
        manager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle,
    ) {
        // The bar is painted at the widget's real width, so a resize repaints it.
        draw(context, manager, intArrayOf(appWidgetId))
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_TOGGLE_PRIVACY) {
            val store = WidgetStore(context)
            store.hidden = !store.hidden
            redrawAll(context)
            return
        }
        super.onReceive(context, intent)
    }

    override fun onEnabled(context: Context) = WidgetRefresh.schedule(context)

    override fun onDisabled(context: Context) = WidgetRefresh.cancel(context)

    companion object {
        const val ACTION_TOGGLE_PRIVACY = "com.maquinita.reader.action.TOGGLE_PRIVACY"

        /** The widget ids currently on a home screen. */
        fun ids(context: Context): IntArray = AppWidgetManager.getInstance(context)
            .getAppWidgetIds(ComponentName(context, MaquinitaWidget::class.java))

        fun redrawAll(context: Context) {
            val ids = ids(context)
            if (ids.isNotEmpty()) draw(context, AppWidgetManager.getInstance(context), ids)
        }

        private fun draw(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val store = WidgetStore(context)
            val settings = Settings(context)
            val now = System.currentTimeMillis()

            for (id in ids) {
                val views = when {
                    !settings.isConfigured -> WidgetRenderer.message(
                        context,
                        context.getString(R.string.widget_pair_title),
                        context.getString(R.string.widget_pair_body),
                    )
                    store.unauthorized -> WidgetRenderer.message(
                        context,
                        context.getString(R.string.widget_unauthorized_title),
                        context.getString(R.string.widget_unauthorized_body),
                    )
                    else -> {
                        val data = store.cachedJson?.let(WidgetData::parse)
                        if (data == null) {
                            WidgetRenderer.message(
                                context,
                                context.getString(R.string.widget_empty_title),
                                context.getString(R.string.widget_empty_body),
                            )
                        } else {
                            val view = WidgetPresenter.present(data, store.hidden, store.fetchedAt, now)
                            WidgetRenderer.summary(context, view, sizeOf(context, manager, id))
                        }
                    }
                }
                manager.updateAppWidget(id, views)
            }
        }

        /** Width and height as the launcher reports them for the current orientation. */
        private fun sizeOf(context: Context, manager: AppWidgetManager, id: Int): WidgetRenderer.SizeDp {
            val options = manager.getAppWidgetOptions(id)
            val landscape = context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
            val width = options.getInt(
                if (landscape) AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH else AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH,
                DEFAULT_WIDTH_DP,
            )
            val height = options.getInt(
                if (landscape) AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT else AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT,
                DEFAULT_HEIGHT_DP,
            )
            return WidgetRenderer.SizeDp(width.takeIf { it > 0 } ?: DEFAULT_WIDTH_DP, height.takeIf { it > 0 } ?: DEFAULT_HEIGHT_DP)
        }

        private const val DEFAULT_WIDTH_DP = 280
        private const val DEFAULT_HEIGHT_DP = 140
    }
}
