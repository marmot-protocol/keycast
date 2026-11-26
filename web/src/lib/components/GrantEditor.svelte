<script lang="ts">
    import Copy from "#lib/components/Copy.svelte";
    import Loader from "#lib/components/Loader.svelte";
    import PolicyCard from "#lib/components/PolicyCard.svelte";
    import { getCurrentUser } from "#lib/current_user.svelte";
    import { KeycastApi } from "#lib/keycast_api.svelte";
    import type {
        GrantCreationResponse,
        Policy,
        StoredKey,
        Team,
        TeamWithRelations,
    } from "#lib/types";
    import { X } from "phosphor-svelte";
    import { toast } from "svelte-hot-french-toast";

    let {
        id,
        pubkey = "",
        availableKeys,
        availablePolicies,
        onDone,
    }: {
        id: string;
        pubkey?: string;
        availableKeys?: StoredKey[];
        availablePolicies?: Policy[];
        onDone?: () => void | Promise<void>;
    } = $props();

    const fixedKey = $derived(pubkey.length > 0);
    // A crafted link can put anything in the route parameter, which would then be
    // signed into the `u` tag of an approval the operator is asked to confirm.
    const invalidPubkey = $derived(fixedKey && !/^[0-9a-f]{64}$/.test(pubkey));
    const api = new KeycastApi();
    const user = $derived(getCurrentUser()?.user);
    let isLoading = $state(true);
    let team: Team | null = $state(null);
    let keys: StoredKey[] = $state([]);
    let policies: Policy[] = $state([]);
    let selectedPubkey = $state("");
    let selectedPolicyId: number | null = $state(null);
    let grantName = $state("");
    let expiresAt = $state("");
    let invitationHours = $state(24);
    let bunkerUri: string | null = $state(null);
    let errorMessage: string | null = $state(null);
    let isSaving = $state(false);

    const activePubkey = $derived(fixedKey ? pubkey : selectedPubkey);
    const activeKey = $derived(keys.find((candidate) => candidate.public_key === activePubkey));

    $effect(() => {
        if (availableKeys && availablePolicies) {
            keys = availableKeys;
            policies = availablePolicies;
            if (!fixedKey && !selectedPubkey && availableKeys[0]) {
                selectedPubkey = availableKeys[0].public_key;
            }
            if (selectedPolicyId === null && availablePolicies.length === 1) {
                selectedPolicyId = availablePolicies[0].id;
            }
            isLoading = false;
            return;
        }
        if (!user?.pubkey || !isLoading || invalidPubkey) return;
        api.buildAuthHeader(`/teams/${id}`, "GET", user.pubkey)
            .then((authorization) =>
                api.get<TeamWithRelations>(`/teams/${id}`, {
                    headers: { Authorization: authorization },
                }),
            )
            .then((response) => {
                team = response.team;
                keys = response.stored_keys;
                policies = response.policies;
                if (!fixedKey && !selectedPubkey && response.stored_keys[0]) {
                    selectedPubkey = response.stored_keys[0].public_key;
                }
                if (selectedPolicyId === null && response.policies.length === 1) {
                    selectedPolicyId = response.policies[0].id;
                }
            })
            .catch((error) => {
                errorMessage =
                    error instanceof Error ? error.message : String(error);
            })
            .finally(() => {
                isLoading = false;
            });
    });

    async function createGrant() {
        if (!user?.pubkey || !selectedPolicyId || !activePubkey || isSaving) return;
        const now = Math.floor(Date.now() / 1000);
        const trimmedName = grantName.trim();
        if (!trimmedName) {
            errorMessage = "Enter a connection name.";
            return;
        }
        const parsedExpiresAt = expiresAt
            ? Math.floor(new Date(expiresAt).getTime() / 1000)
            : null;
        if (parsedExpiresAt !== null && (!Number.isFinite(parsedExpiresAt) || parsedExpiresAt <= now)) {
            errorMessage = "Connection expiration must be in the future.";
            return;
        }
        const hours = Math.max(1, Math.min(168, Math.floor(Number(invitationHours) || 24)));
        const invitationExpiresAt = Math.min(
            now + hours * 3600,
            parsedExpiresAt ?? Infinity,
        );
        const request = {
            name: trimmedName,
            policy_id: selectedPolicyId,
            expires_at: parsedExpiresAt,
            invitation_expires_at: invitationExpiresAt,
        };
        errorMessage = null;
        isSaving = true;
        try {
            const endpoint = `/teams/${id}/keys/${activePubkey}/grants`;
            const body = JSON.stringify(request);
            const authorization = await api.buildAuthHeader(
                endpoint,
                "POST",
                user.pubkey,
                body,
            );
            const response = await api.post<GrantCreationResponse>(
                endpoint,
                request,
                { headers: { Authorization: authorization } },
            );
            bunkerUri = response.bunker_uri;
            toast.success("Connection and one-time invitation created");
        } catch (error) {
            errorMessage =
                error instanceof Error ? error.message : String(error);
        } finally {
            isSaving = false;
        }
    }
</script>

{#if invalidPubkey}
    <div role="alert">
        <p class="input-error">
            That is not a valid Nostr public key. Start from your workspace
            instead of following the link.
        </p>
    </div>
{:else if isLoading}
    <Loader />
{:else if bunkerUri}
    <h2 class="page-header">One-time invitation ready</h2>
    <div class="card max-w-3xl">
        <p class="text-warning text-sm">
            This <code>bunker://</code> URL is shown once. Copy it now — Keycast stores only a SHA-256 hash of its secret.
        </p>
        <div
            class="flex gap-2 items-center font-mono text-xs break-all bg-canvas p-3 rounded-md border border-line"
        >
            <span class="grow select-all">{bunkerUri}</span><Copy value={bunkerUri} label="Copy bunker URI" />
        </div>
        <p class="description">
            <strong>NIP-46 pairing note:</strong> The secret is single-use. Your app or CLI pairs once and reuses its client key on future requests. For <code>nak</code>, use a recent version or pass a persistent <code>--connect-as</code> / <code>NOSTR_CLIENT_KEY</code> so each run keeps the same client identity.
        </p>
        {#if onDone}<button
                type="button"
                class="button button-primary self-start"
                onclick={onDone}>Done</button
            >{:else}<a
                href={`/teams/${id}/keys/${activePubkey}`}
                class="button button-primary self-start">Done</a
            >{/if}
    </div>
{:else}
    <h2 class="page-header">Connect an app</h2>
    <p class="description mb-5">
        Pair a signing key with a policy to create a dedicated NIP-46 connection and one-time <code>bunker://</code> invitation.
    </p>
    <form
        onsubmit={(event) => {
            event.preventDefault();
            createGrant();
        }}
        class="flex flex-col gap-5"
    >
        {#if !fixedKey}
            <div class="form-group">
                <label for="grantKey">Signing key</label>
                <select id="grantKey" bind:value={selectedPubkey} required>
                    {#each keys as candidate (candidate.id)}
                        <option value={candidate.public_key}>{candidate.name}</option>
                    {/each}
                </select>
            </div>
        {:else if activeKey}
            <p class="text-xs text-muted">
                Signing key: <strong class="text-ink">{activeKey.name}</strong>
            </p>
        {/if}
        <div class="form-group">
            <label for="grantName">Connection name (app, device, or teammate)</label>
            <input
                id="grantName"
                type="text"
                required
                maxlength="120"
                bind:value={grantName}
                placeholder="e.g. nak — Zapstore CLI (Alex)"
            />
        </div>
        <div class="grid sm:grid-cols-2 gap-4">
            <div class="form-group">
                <label for="expiresAt">Connection expiration (optional)</label>
                <div class="flex gap-2 items-center">
                    <input
                        id="expiresAt"
                        type="datetime-local"
                        bind:value={expiresAt}
                    />
                    {#if expiresAt}<button
                            type="button"
                            aria-label="Clear connection expiration"
                            onclick={() => (expiresAt = "")}><X size={16} /></button
                        >{/if}
                </div>
            </div>
            <div class="form-group">
                <label for="invitationHours">One-time invitation lifetime (hours)</label>
                <input
                    id="invitationHours"
                    type="number"
                    min="1"
                    max="168"
                    bind:value={invitationHours}
                    required
                />
            </div>
        </div>
        <div>
            <h2 class="page-subheader">Policy</h2>
            {#if policies.length === 0}
                <p class="text-muted text-sm">
                    Create a policy in the <strong>Policies</strong> tab before connecting an app.
                </p>
            {:else}
                <div class="flex flex-col gap-2">
                    {#each policies as policy (policy.id)}
                        <label
                            class="flex items-start gap-3 p-3.5 rounded-lg border border-line bg-surface cursor-pointer transition-colors hover:border-white/20"
                            class:border-accent={selectedPolicyId === policy.id}
                        >
                            <input
                                class="mt-1"
                                type="radio"
                                name="grant-policy"
                                value={policy.id}
                                bind:group={selectedPolicyId}
                            />
                            <div class="min-w-0 grow">
                                <PolicyCard {policy} />
                            </div>
                        </label>
                    {/each}
                </div>
            {/if}
        </div>
        {#if errorMessage}<p class="input-error">{errorMessage}</p>{/if}
        <button
            type="submit"
            class="button button-primary self-start"
            disabled={!selectedPolicyId || !activePubkey || isSaving}
        >
            {isSaving ? "Creating…" : "Create connection & invitation"}
        </button>
    </form>
{/if}
