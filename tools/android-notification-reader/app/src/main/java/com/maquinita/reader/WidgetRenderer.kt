package com.maquinita.reader

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews

/** Turns a [WidgetView] into RemoteViews. All the decisions are made before this. */
object WidgetRenderer {

    /** Below this height the labels go: the two-line columns no longer fit. */
    private const val COMPACT_BELOW_DP = 128

    /**
     * The card's horizontal padding in widget_maquinita.xml: 16dp at the start and
     * 12dp at the end. The bar is painted at the width that is left, so if the
     * padding changes there it has to change here, or the bar is stretched.
     */
    private const val BAR_INSET_DP = 28

    private const val BAR_HEIGHT_DP = 12

    private const val REQUEST_OPEN = 1
    private const val REQUEST_TOGGLE = 2
    private const val REQUEST_CONFIG = 3

    /** The size the launcher gave this widget, in dp. */
    data class SizeDp(val width: Int, val height: Int)

    fun summary(context: Context, view: WidgetView, size: SizeDp): RemoteViews {
        val density = context.resources.displayMetrics.density
        val compact = size.height < COMPACT_BELOW_DP
        val tone = context.getColor(toneColor(view.tone))

        return RemoteViews(context.packageName, R.layout.widget_maquinita).apply {
            setImageViewResource(R.id.state_dot, toneDot(view.tone))
            setTextViewText(R.id.title, view.title)
            setTextViewText(R.id.subtitle, view.subtitle)

            setTextViewText(R.id.updated, view.updated)
            setTextColor(R.id.updated, context.getColor(if (view.updatedStale) R.color.tone_warning else R.color.widget_tertiary))

            setTextViewText(R.id.spent, view.spent)
            setTextViewTextSize(R.id.spent, TypedValue.COMPLEX_UNIT_SP, if (compact) 24f else 28f)
            setTextViewText(R.id.of_ceiling, view.ofCeiling)
            setTextViewText(R.id.pct, view.pct)
            setTextColor(R.id.pct, tone)

            if (view.bar is BarStyle.None) {
                setViewVisibility(R.id.bar, View.GONE)
            } else {
                setViewVisibility(R.id.bar, View.VISIBLE)
                val widthPx = ((size.width - BAR_INSET_DP) * density).toInt()
                val heightPx = (BAR_HEIGHT_DP * density).toInt()
                setImageViewBitmap(R.id.bar, BarRenderer.render(widthPx, heightPx, density, view.bar, tone))
            }

            // Short widgets: the labels go and each column keeps a single line.
            val labels = if (compact) View.GONE else View.VISIBLE
            setViewVisibility(R.id.daily_label, labels)
            setViewVisibility(R.id.last_label, labels)
            setTextViewText(R.id.daily_label, view.dailyLabel)
            setTextViewText(R.id.last_label, view.lastLabel)
            setTextViewText(R.id.daily_value, if (compact) view.dailyCompact else view.dailyValue)
            setTextViewText(R.id.last_merchant, view.lastMerchant)
            setTextViewText(R.id.last_amount, view.lastAmount)

            setImageViewResource(R.id.btn_privacy, if (view.hidden) R.drawable.ic_eye_off else R.drawable.ic_eye)
            setContentDescription(
                R.id.btn_privacy,
                context.getString(if (view.hidden) R.string.widget_show_values else R.string.widget_hide_values),
            )
            setContentDescription(R.id.widget_root, view.description)

            setOnClickPendingIntent(R.id.btn_privacy, togglePrivacy(context))
            setOnClickPendingIntent(R.id.widget_root, openExpenses(context))
        }
    }

    /** Nothing to show yet, or something to fix: a short message, tapping opens the reader config. */
    fun message(context: Context, title: String, body: String): RemoteViews =
        RemoteViews(context.packageName, R.layout.widget_message).apply {
            setTextViewText(R.id.message_title, title)
            setTextViewText(R.id.message_body, body)
            setOnClickPendingIntent(R.id.widget_root, openConfig(context))
        }

    private fun toneColor(tone: Tone): Int = when (tone) {
        Tone.POSITIVE -> R.color.tone_positive
        Tone.WARNING -> R.color.tone_warning
        Tone.DANGER -> R.color.tone_danger
        Tone.NEUTRAL -> R.color.tone_neutral
    }

    private fun toneDot(tone: Tone): Int = when (tone) {
        Tone.POSITIVE -> R.drawable.dot_positive
        Tone.WARNING -> R.drawable.dot_warning
        Tone.DANGER -> R.drawable.dot_danger
        Tone.NEUTRAL -> R.drawable.dot_neutral
    }

    /** The dashboard on the expenses page. Same origin the Digital Asset Links verify. */
    private fun openExpenses(context: Context): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(context.getString(R.string.twa_url) + "/gastos"))
            .setClass(context, LauncherActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(context, REQUEST_OPEN, intent, IMMUTABLE_UPDATE)
    }

    private fun openConfig(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(context, REQUEST_CONFIG, intent, IMMUTABLE_UPDATE)
    }

    /** Explicit and immutable: only this app's receiver can be reached, and nothing can rewrite the intent. */
    private fun togglePrivacy(context: Context): PendingIntent {
        val intent = Intent(context, MaquinitaWidget::class.java).setAction(MaquinitaWidget.ACTION_TOGGLE_PRIVACY)
        return PendingIntent.getBroadcast(context, REQUEST_TOGGLE, intent, IMMUTABLE_UPDATE)
    }

    private const val IMMUTABLE_UPDATE = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
}
