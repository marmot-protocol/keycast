<script lang="ts">
    import type { Grant, Policy } from "#lib/types";
    import { policyCapabilityChips } from "#lib/utils/diagnostics";
    import { PencilSimple, Trash } from "phosphor-svelte";

    let {
        policy,
        usedByGrants = [],
        hoverable = false,
        editHref,
        onRemove,
        onEdit,
    }: {
        policy: Policy;
        usedByGrants?: Grant[];
        hoverable?: boolean;
        editHref?: string;
        onEdit?: (policy: Policy) => void;
        onRemove?: (policy: Policy) => Promise<void> | void;
    } = $props();

    let busy = $state(false);

    async function remove() {
        if (!onRemove) return;
        busy = true;
        try {
            await onRemove(policy);
        } finally {
            busy = false;
        }
    }

    const chips = $derived(policyCapabilityChips(policy));
    const activeGrants = $derived(
        usedByGrants.filter(
            (g) =>
                g.revoked_at === null &&
                (g.expires_at === null || g.expires_at > Math.floor(Date.now() / 1000)),
        ),
    );
</script>

<div class={hoverable ? "hover-card" : ""}>
    <div class="flex flex-wrap items-baseline justify-between gap-2">
        <div class="flex items-center gap-2 flex-wrap">
            <h3 class="text-sm font-semibold">{policy.name}</h3>
            <span class="font-mono text-[11px] text-muted">rev {policy.revision}</span>
        </div>
        {#if usedByGrants.length > 0}
            <span class="badge badge-neutral">
                {activeGrants.length} active {activeGrants.length === 1 ? "connection" : "connections"}
            </span>
        {/if}
    </div>

    <div class="chip-list mt-2">
        {#each chips as chip}
            <span class="kind-chip">{chip}</span>
        {:else}
            <span class="text-xs text-danger">
                Unknown policy document; all requests are denied.
            </span>
        {/each}
    </div>

    {#if activeGrants.length > 0}
        <p class="text-[11px] text-muted mt-2">
            Used by: {activeGrants.map((g) => g.name).join(", ")}
        </p>
    {/if}

    {#if editHref || onEdit || onRemove}
        <div class="flex flex-wrap gap-2 mt-3">
            {#if onEdit}<button
                    type="button"
                    class="button button-secondary"
                    onclick={() => onEdit?.(policy)}
                >
                    <PencilSimple size={14} /> Edit
                </button>{/if}
            {#if editHref}<a
                    href={editHref}
                    class="button button-secondary button-icon"
                    ><PencilSimple size={14} /> Edit</a
                >{/if}
            {#if onRemove}<button
                    type="button"
                    class="button button-danger button-icon"
                    onclick={remove}
                    disabled={busy || activeGrants.length > 0}
                    title={activeGrants.length > 0
                        ? "Revoke active connections using this policy before deleting it"
                        : "Delete policy"}
                    ><Trash size={14} /> Delete</button
                >{/if}
        </div>
    {/if}
</div>
