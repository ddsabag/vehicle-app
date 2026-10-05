package com.ddsabag.pratirechev;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.ConsumeParams;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * Google Play Billing: PRO and PRO business subscriptions, and the one-time buyer pack (60 days).
 * The page asks for a purchase and is told the resulting plan; the page never decides on its own.
 * Subscriptions are re-checked against Google Play on every start, the buyer pack is stored here.
 */
class BillingManager implements PurchasesUpdatedListener {
    static final String BUYER = "buyer_pack", PRO_M = "pro_monthly", PRO_Y = "pro_yearly", BIZ = "biz_monthly";
    private static final long BUYER_DAYS = 60;
    private static final long OFFLINE_GRACE_DAYS = 3;
    private static final String PREFS = "billing";

    private final Context ctx;
    private final Consumer<String> js;
    private final Map<String, ProductDetails> details = new HashMap<>();
    private BillingClient client;
    private boolean ready = false;

    BillingManager(Context ctx, Consumer<String> js) {
        this.ctx = ctx.getApplicationContext();
        this.js = js;
    }

    private SharedPreferences prefs() {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Connects once; later calls only refresh */
    void init() {
        publish();
        if (client == null) {
            client = BillingClient.newBuilder(ctx)
                    .setListener(this)
                    .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
                    .build();
        }
        if (ready) {
            refresh();
            return;
        }
        client.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(@NonNull BillingResult r) {
                if (r.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    ready = true;
                    queryDetails();
                    refresh();
                }
            }

            @Override
            public void onBillingServiceDisconnected() {
                ready = false;
            }
        });
    }

    private void queryDetails() {
        List<QueryProductDetailsParams.Product> subs = new ArrayList<>(), inapp = new ArrayList<>();
        for (String id : new String[]{PRO_M, PRO_Y, BIZ})
            subs.add(QueryProductDetailsParams.Product.newBuilder().setProductId(id).setProductType(BillingClient.ProductType.SUBS).build());
        inapp.add(QueryProductDetailsParams.Product.newBuilder().setProductId(BUYER).setProductType(BillingClient.ProductType.INAPP).build());
        client.queryProductDetailsAsync(QueryProductDetailsParams.newBuilder().setProductList(subs).build(), (r, res) -> collect(r, res.getProductDetailsList()));
        client.queryProductDetailsAsync(QueryProductDetailsParams.newBuilder().setProductList(inapp).build(), (r, res) -> collect(r, res.getProductDetailsList()));
    }

    private void collect(BillingResult r, List<ProductDetails> list) {
        if (r.getResponseCode() != BillingClient.BillingResponseCode.OK || list == null) return;
        for (ProductDetails d : list) details.put(d.getProductId(), d);
        try {
            JSONObject prices = new JSONObject();
            boolean credit = false;
            for (ProductDetails d : details.values()) {
                if (d.getSubscriptionOfferDetails() != null && !d.getSubscriptionOfferDetails().isEmpty()) {
                    List<ProductDetails.PricingPhase> ph = d.getSubscriptionOfferDetails().get(0).getPricingPhases().getPricingPhaseList();
                    prices.put(d.getProductId(), ph.get(ph.size() - 1).getFormattedPrice());
                    if (PRO_Y.equals(d.getProductId()) && creditOffer(d) != null) credit = true;
                } else if (d.getOneTimePurchaseOfferDetails() != null) {
                    prices.put(d.getProductId(), d.getOneTimePurchaseOfferDetails().getFormattedPrice());
                }
            }
            prices.put("_credit", credit);
            js.accept("window.onPrices && window.onPrices(" + JSONObject.quote(prices.toString()) + ")");
        } catch (Exception ignored) {
        }
    }

    /** The yearly offer meant for people who bought the buyer pack (offer tag "buyer-credit") */
    @Nullable
    private static ProductDetails.SubscriptionOfferDetails creditOffer(ProductDetails d) {
        if (d.getSubscriptionOfferDetails() == null) return null;
        for (ProductDetails.SubscriptionOfferDetails o : d.getSubscriptionOfferDetails())
            if (o.getOfferTags().contains("buyer-credit")) return o;
        return null;
    }

    /** Re-reads what Google Play says the user owns */
    void refresh() {
        if (!ready) return;
        client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build(), (r, list) -> {
            if (r.getResponseCode() != BillingClient.BillingResponseCode.OK) return;
            handle(list);
            String plan = "";
            for (Purchase p : list) {
                if (p.getPurchaseState() != Purchase.PurchaseState.PURCHASED) continue;
                if (p.getProducts().contains(BIZ)) plan = "biz";
                else if (plan.isEmpty() && (p.getProducts().contains(PRO_M) || p.getProducts().contains(PRO_Y))) plan = "pro";
            }
            prefs().edit().putString("plan", plan).putLong("until", plan.isEmpty() ? 0 : System.currentTimeMillis() + TimeUnit.DAYS.toMillis(OFFLINE_GRACE_DAYS)).apply();
            publish();
        });
        client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.INAPP).build(), (r, list) -> {
            if (r.getResponseCode() == BillingClient.BillingResponseCode.OK) handle(list);
        });
    }

    void purchase(Activity activity, String sku) {
        if (!ready || !details.containsKey(sku)) {
            error("הרכישה עדיין לא זמינה. נסו שוב מאוחר יותר.");
            return;
        }
        ProductDetails d = details.get(sku);
        BillingFlowParams.ProductDetailsParams.Builder pd = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(d);
        if (d.getSubscriptionOfferDetails() != null && !d.getSubscriptionOfferDetails().isEmpty()) {
            ProductDetails.SubscriptionOfferDetails offer = null;
            if (PRO_Y.equals(sku) && prefs().getLong("buyerUntil", 0) > System.currentTimeMillis()) offer = creditOffer(d);
            if (offer == null) {
                // prefer the offer with a free trial, otherwise the first (base plan) offer
                for (ProductDetails.SubscriptionOfferDetails o : d.getSubscriptionOfferDetails()) {
                    if (o.getOfferTags().contains("buyer-credit")) continue;
                    if (offer == null || o.getPricingPhases().getPricingPhaseList().size() > offer.getPricingPhases().getPricingPhaseList().size()) offer = o;
                }
            }
            if (offer == null) offer = d.getSubscriptionOfferDetails().get(0);
            pd.setOfferToken(offer.getOfferToken());
        }
        List<BillingFlowParams.ProductDetailsParams> l = new ArrayList<>();
        l.add(pd.build());
        BillingResult r = client.launchBillingFlow(activity, BillingFlowParams.newBuilder().setProductDetailsParamsList(l).build());
        if (r.getResponseCode() != BillingClient.BillingResponseCode.OK) error("לא הצלחנו לפתוח את חלון הרכישה.");
    }

    @Override
    public void onPurchasesUpdated(@NonNull BillingResult r, @Nullable List<Purchase> purchases) {
        int code = r.getResponseCode();
        if (code == BillingClient.BillingResponseCode.OK && purchases != null) {
            handle(purchases);
            refresh();
        } else if (code == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) {
            refresh();
        } else if (code != BillingClient.BillingResponseCode.USER_CANCELED) {
            error("הרכישה לא הושלמה.");
        }
    }

    private void handle(@Nullable List<Purchase> purchases) {
        if (purchases == null) return;
        for (Purchase p : purchases) {
            if (p.getPurchaseState() == Purchase.PurchaseState.PENDING) {
                js.accept("window.toast && toast('התשלום ממתין לאישור')");
                continue;
            }
            if (p.getPurchaseState() != Purchase.PurchaseState.PURCHASED) continue;
            if (p.getProducts().contains(BUYER)) {
                // one-time pack: grant 60 days, then consume so it can be bought again
                client.consumeAsync(ConsumeParams.newBuilder().setPurchaseToken(p.getPurchaseToken()).build(), (br, token) -> {
                    if (br.getResponseCode() != BillingClient.BillingResponseCode.OK) return;
                    long base = Math.max(System.currentTimeMillis(), prefs().getLong("buyerUntil", 0));
                    prefs().edit().putLong("buyerUntil", base + TimeUnit.DAYS.toMillis(BUYER_DAYS)).apply();
                    publish();
                });
            } else if (!p.isAcknowledged()) {
                client.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(p.getPurchaseToken()).build(), br -> {
                });
            }
        }
    }

    /** Tells the page the plan Google Play has confirmed */
    private void publish() {
        try {
            SharedPreferences p = prefs();
            JSONObject o = new JSONObject();
            o.put("plan", p.getString("plan", ""));
            o.put("until", p.getLong("until", 0));
            o.put("buyerUntil", p.getLong("buyerUntil", 0));
            js.accept("window.onEntitlement && window.onEntitlement(" + JSONObject.quote(o.toString()) + ")");
        } catch (Exception ignored) {
        }
    }

    private void error(String msg) {
        js.accept("window.toast && toast(" + JSONObject.quote(msg) + ")");
    }
}
