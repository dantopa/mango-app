export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      accounts: {
        Row: {
          country: string | null
          created_at: string
          id: string
          is_active: boolean
          name: string
          native_currency: string
          payment_type: string | null
          type: Database["public"]["Enums"]["account_type"]
          user_id: string
        }
        Insert: {
          country?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          native_currency: string
          payment_type?: string | null
          type: Database["public"]["Enums"]["account_type"]
          user_id?: string
        }
        Update: {
          country?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          native_currency?: string
          payment_type?: string | null
          type?: Database["public"]["Enums"]["account_type"]
          user_id?: string
        }
        Relationships: []
      }
      categories: {
        Row: {
          color: string
          created_at: string
          id: string
          monthly_budget_usd: number | null
          name: string
          parent_id: string | null
          user_id: string
        }
        Insert: {
          color?: string
          created_at?: string
          id?: string
          monthly_budget_usd?: number | null
          name: string
          parent_id?: string | null
          user_id?: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          monthly_budget_usd?: number | null
          name?: string
          parent_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "categories_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      goals: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          start_date: string
          start_usd: number
          target_date: string
          target_usd: number
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          start_date: string
          start_usd: number
          target_date: string
          target_usd: number
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          start_date?: string
          start_usd?: number
          target_date?: string
          target_usd?: number
          user_id?: string
        }
        Relationships: []
      }
      merchant_category_rules: {
        Row: {
          category_id: string
          created_at: string
          id: string
          match_type: string
          pattern: string
          priority: number
          user_id: string
        }
        Insert: {
          category_id: string
          created_at?: string
          id?: string
          match_type?: string
          pattern: string
          priority?: number
          user_id: string
        }
        Update: {
          category_id?: string
          created_at?: string
          id?: string
          match_type?: string
          pattern?: string
          priority?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_category_rules_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      monthly_close: {
        Row: {
          closed_at: string | null
          created_at: string
          id: string
          net_worth_usd: number | null
          notes: string | null
          period: string
          savings_usd: number | null
          status: string
          total_spend_usd: number | null
          user_id: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          id?: string
          net_worth_usd?: number | null
          notes?: string | null
          period: string
          savings_usd?: number | null
          status?: string
          total_spend_usd?: number | null
          user_id?: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          id?: string
          net_worth_usd?: number | null
          notes?: string | null
          period?: string
          savings_usd?: number | null
          status?: string
          total_spend_usd?: number | null
          user_id?: string
        }
        Relationships: []
      }
      monthly_close_items: {
        Row: {
          close_id: string
          created_at: string
          id: string
          item_type: string
          loaded_at: string | null
          source: string
          status: string
          user_id: string
        }
        Insert: {
          close_id: string
          created_at?: string
          id?: string
          item_type: string
          loaded_at?: string | null
          source: string
          status?: string
          user_id?: string
        }
        Update: {
          close_id?: string
          created_at?: string
          id?: string
          item_type?: string
          loaded_at?: string | null
          source?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "monthly_close_items_close_id_fkey"
            columns: ["close_id"]
            isOneToOne: false
            referencedRelation: "monthly_close"
            referencedColumns: ["id"]
          },
        ]
      }
      net_worth_snapshots: {
        Row: {
          account_id: string
          balance_native: number
          balance_usd: number
          created_at: string
          fx_rate_to_usd: number
          id: string
          is_pending: boolean
          native_currency: string
          notes: string | null
          snapshot_date: string
          user_id: string
        }
        Insert: {
          account_id: string
          balance_native: number
          balance_usd: number
          created_at?: string
          fx_rate_to_usd: number
          id?: string
          is_pending?: boolean
          native_currency: string
          notes?: string | null
          snapshot_date: string
          user_id?: string
        }
        Update: {
          account_id?: string
          balance_native?: number
          balance_usd?: number
          created_at?: string
          fx_rate_to_usd?: number
          id?: string
          is_pending?: boolean
          native_currency?: string
          notes?: string | null
          snapshot_date?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "net_worth_snapshots_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      push_ingest_log: {
        Row: {
          amount_native: number | null
          amount_usd: number | null
          created_at: string
          dedup_key: string
          error_message: string | null
          merchant: string | null
          native_currency: string | null
          package_name: string
          raw_log_id: string | null
          related_dedup_key: string | null
          status: string
          transaction_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amount_native?: number | null
          amount_usd?: number | null
          created_at?: string
          dedup_key: string
          error_message?: string | null
          merchant?: string | null
          native_currency?: string | null
          package_name: string
          raw_log_id?: string | null
          related_dedup_key?: string | null
          status?: string
          transaction_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amount_native?: number | null
          amount_usd?: number | null
          created_at?: string
          dedup_key?: string
          error_message?: string | null
          merchant?: string | null
          native_currency?: string | null
          package_name?: string
          raw_log_id?: string | null
          related_dedup_key?: string | null
          status?: string
          transaction_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_ingest_log_raw_log_id_fkey"
            columns: ["raw_log_id"]
            isOneToOne: false
            referencedRelation: "push_raw_log"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_ingest_log_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      push_raw_log: {
        Row: {
          created_at: string
          id: string
          package_name: string
          payload: Json
          received_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          package_name: string
          payload: Json
          received_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          package_name?: string
          payload?: Json
          received_at?: string
          user_id?: string
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          created_at: string
          endpoint: string
          id: string
          keys_auth: string
          keys_p256dh: string
          user_id: string
        }
        Insert: {
          created_at?: string
          endpoint: string
          id?: string
          keys_auth: string
          keys_p256dh: string
          user_id: string
        }
        Update: {
          created_at?: string
          endpoint?: string
          id?: string
          keys_auth?: string
          keys_p256dh?: string
          user_id?: string
        }
        Relationships: []
      }
      transactions: {
        Row: {
          account_id: string
          amount_native: number
          amount_usd: number
          card_last4: string | null
          category_id: string | null
          country: string
          created_at: string
          description_raw: string
          expense_type: string
          external_ts: string | null
          fx_rate_to_usd: number
          id: string
          installments: string | null
          is_extraordinary: boolean
          is_payment: boolean
          merchant: string | null
          native_currency: string
          needs_review: boolean
          payment_type: string | null
          source: string
          statement_period: string | null
          tx_date: string
          user_id: string
        }
        Insert: {
          account_id: string
          amount_native: number
          amount_usd: number
          card_last4?: string | null
          category_id?: string | null
          country?: string
          created_at?: string
          description_raw: string
          expense_type?: string
          external_ts?: string | null
          fx_rate_to_usd: number
          id?: string
          installments?: string | null
          is_extraordinary?: boolean
          is_payment?: boolean
          merchant?: string | null
          native_currency: string
          needs_review?: boolean
          payment_type?: string | null
          source?: string
          statement_period?: string | null
          tx_date: string
          user_id?: string
        }
        Update: {
          account_id?: string
          amount_native?: number
          amount_usd?: number
          card_last4?: string | null
          category_id?: string | null
          country?: string
          created_at?: string
          description_raw?: string
          expense_type?: string
          external_ts?: string | null
          fx_rate_to_usd?: number
          id?: string
          installments?: string | null
          is_extraordinary?: boolean
          is_payment?: boolean
          merchant?: string | null
          native_currency?: string
          needs_review?: boolean
          payment_type?: string | null
          source?: string
          statement_period?: string | null
          tx_date?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transactions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      transfer_classification_rules: {
        Row: {
          created_at: string
          description: string | null
          id: string
          list_type: string
          match_type: string
          pattern: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          list_type?: string
          match_type?: string
          pattern: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          list_type?: string
          match_type?: string
          pattern?: string
          user_id?: string
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          budget_ceiling_usd: number | null
          created_at: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          budget_ceiling_usd?: number | null
          created_at?: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          budget_ceiling_usd?: number | null
          created_at?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      vault_get_secret: { Args: { p_name: string }; Returns: string }
      vault_read_secret: { Args: { secret_name: string }; Returns: string }
      vault_upsert_secret: {
        Args: { p_name: string; p_secret: string }
        Returns: undefined
      }
      vault_write_secret: {
        Args: { secret_name: string; secret_value: string }
        Returns: undefined
      }
    }
    Enums: {
      account_type: "crypto" | "broker" | "bank" | "wallet" | "cash"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_type: ["crypto", "broker", "bank", "wallet", "cash"],
    },
  },
} as const
