-- Paying customers locked out of what they bought.
--
-- Two billing systems grew up side by side. The fleet portal's Billing page
-- sells flat plans (Starter/Growth/Professional/Empire) and records the
-- choice in organizations.plan_key, charged by a Paystack recurring
-- subscription. Everything else — feature gating, our own billing run,
-- invoices, dunning, EFT and suspension — reads organizations.subscription_tier
-- and the ladder basic -> workshop -> fleet -> complete.
--
-- tierFeatures.effectiveTier() falls back to 'basic' for any value it does
-- not recognise, and 'medium' is not on the ladder. So a customer paying
-- R750/month for Growth is served the Basic feature set: no agreements, no
-- payments, no riders, no collections, no workshop, no applications.
--
-- One wrinkle the database caught: the code's plan list calls the top plan
-- 'empire', but organizations_plan_key_check only permits
-- trial/small/medium/large/enterprise. 'empire' can never have been stored,
-- so the mapping below uses the values that can actually exist. Orgs still
-- on 'trial' are left alone — effectiveTier already gives a trialing account
-- the full product, and granting a paid tier to a trial is not a fix.
--
-- This sets subscription_tier to what each flat plan actually promised, so
-- people get what they are paying for today. It is deliberately generous:
-- the flat plans were sold on bike count and admin seats, and nothing in
-- their copy excluded the operational product. Repricing onto the per-bike
-- ladder is a separate conversation with each customer, not a silent
-- downgrade now.
--
-- WHY THIS DOES NOT START A SECOND CHARGE
--
-- subscriptionBilling.organizationsDue() requires either a stored card
-- (billing_authorization_encrypted) or billing_method = 'eft'. Only the
-- per-bike flow (/api/fleet/subscription/confirm) ever calls
-- rememberAuthorization, so a flat-plan customer has no stored card and is
-- invisible to our billing run. Setting subscription_tier unlocks features
-- and raises no invoice. Step 1 below proves that for your data before step
-- 2 changes anything — if any row comes back with would_double_bill = true,
-- stop and deal with those by hand.

-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — read only. Who is affected, and is anyone at risk of two charges?
-- ───────────────────────────────────────────────────────────────────────────
SELECT
  o.id,
  o.name,
  o.plan_key,
  o.status,
  o.subscription_status,
  o.subscription_tier                                   AS tier_now,
  CASE
    WHEN o.status = 'trialing'                 THEN 'complete (on trial)'
    WHEN o.subscription_tier IN ('basic','workshop','fleet','complete')
                                               THEN o.subscription_tier
    ELSE 'basic  <-- locked out'
  END                                                   AS effective_tier_now,
  CASE o.plan_key
    WHEN 'small'      THEN 'fleet'
    WHEN 'medium'     THEN 'fleet'
    WHEN 'large'      THEN 'fleet'
    WHEN 'enterprise' THEN 'complete'
  END                                                   AS tier_after,
  (o.paystack_subscription_code IS NOT NULL)            AS pays_via_paystack_subscription,
  (o.billing_authorization_encrypted IS NOT NULL)       AS has_card_on_file,
  o.billing_method,
  -- The thing to check before running step 2. True means this org would
  -- become due in our billing run as well as being charged by Paystack.
  (
    o.paystack_subscription_code IS NOT NULL
    AND (o.billing_authorization_encrypted IS NOT NULL OR o.billing_method = 'eft')
  )                                                     AS would_double_bill,
  (SELECT COUNT(*) FROM bikes b
    WHERE b.organization_id = o.id AND b.status NOT IN ('sold','written_off')) AS bikes
FROM organizations o
WHERE o.plan_key IN ('small','medium','large','enterprise')
ORDER BY o.id;

-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — the unblock. Run only if STEP 1 showed would_double_bill = false
-- for every row. Wrapped in a transaction so the count can be checked before
-- it is kept.
-- ───────────────────────────────────────────────────────────────────────────
BEGIN;

UPDATE organizations o
   SET subscription_tier = CASE o.plan_key
         WHEN 'small'      THEN 'fleet'
         WHEN 'medium'     THEN 'fleet'
         WHEN 'large'      THEN 'fleet'
         WHEN 'enterprise' THEN 'complete'
       END,
       updated_at = NOW()
 WHERE o.plan_key IN ('small','medium','large','enterprise')
   -- Never touch an org our billing run can already charge: that is the one
   -- shape where adding a tier could mean two charges for one month.
   AND o.billing_authorization_encrypted IS NULL
   AND o.billing_method <> 'eft'
   -- Nothing to do where a real tier is already set.
   AND (o.subscription_tier IS NULL
        OR o.subscription_tier NOT IN ('basic','workshop','fleet','complete'));

-- Expect this to match the number of locked-out rows from step 1.
SELECT id, name, plan_key, subscription_tier
  FROM organizations
 WHERE plan_key IN ('small','medium','large','enterprise')
 ORDER BY id;

-- COMMIT;    -- uncomment once the list above looks right
-- ROLLBACK;  -- or this, to walk away having changed nothing
