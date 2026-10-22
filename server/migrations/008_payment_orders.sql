-- Source only. Separate approval required for execution and runtime grants.
CREATE TABLE IF NOT EXISTS public.telegram_payment_orders (
 owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
 order_id TEXT NOT NULL CHECK(length(order_id) BETWEEN 1 AND 128),
 bot_alias TEXT NOT NULL CHECK(length(bot_alias) BETWEEN 1 AND 64),
 invoice_payload TEXT NOT NULL CHECK(octet_length(invoice_payload) BETWEEN 1 AND 128),
 document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
 PRIMARY KEY(owner_id,order_id), UNIQUE(owner_id,bot_alias,invoice_payload),
 UNIQUE(owner_id,order_id,bot_alias),
 CHECK((document->'order'->>'id'=order_id) IS TRUE),
 CHECK((document->'order'->>'botAlias'=bot_alias) IS TRUE),
 CHECK((document->'order'->>'invoicePayload'=invoice_payload) IS TRUE)
);
CREATE TABLE IF NOT EXISTS public.telegram_payment_charge_bindings (
 owner_id TEXT NOT NULL, bot_alias TEXT NOT NULL,
 charge_id TEXT NOT NULL CHECK(length(charge_id) BETWEEN 1 AND 1024), order_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,bot_alias,charge_id),
 FOREIGN KEY(owner_id,order_id,bot_alias) REFERENCES public.telegram_payment_orders(owner_id,order_id,bot_alias)
);
ALTER TABLE public.telegram_payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_payment_charge_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_payment_orders,public.telegram_payment_charge_bindings FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON public.telegram_payment_orders,public.telegram_payment_charge_bindings FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
-- No runtime grants/policies, startup migration, checkout acceptance or money movement.
