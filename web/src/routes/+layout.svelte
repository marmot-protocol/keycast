<script lang="ts">
    import "../app.css";
    import Header from "#lib/components/Header.svelte";
    import { getCurrentUser, setCurrentUser } from "#lib/current_user.svelte";
    import { initApi } from "#lib/keycast_api.svelte";
    import { clearActiveSigner, restoreActiveSigner } from "#lib/nostr";
    import { untrack } from "svelte";
    import { Toaster } from "svelte-hot-french-toast";

    let { data, children } = $props();
    let keycastCookie = $derived(data.keycastCookie);
    initApi();

    $effect(() => {
        const pubkey = keycastCookie ?? null;
        // Only refreshed server data should hydrate the user. Tracking local
        // sign-out here would restore the user from the previous cookie value.
        untrack(() => {
            if ((getCurrentUser()?.user?.pubkey ?? null) !== pubkey) {
                setCurrentUser(pubkey);
            }
            if (pubkey) {
                void restoreActiveSigner(pubkey);
            } else {
                clearActiveSigner();
            }
        });
    });
</script>

<Toaster
    toastOptions={{
        style: "background: #181d25; color: #edf1f7; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 8px; font-size: 13px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);",
    }}
/>
<Header />
<main id="main-content" class="app-main">{@render children()}</main>
