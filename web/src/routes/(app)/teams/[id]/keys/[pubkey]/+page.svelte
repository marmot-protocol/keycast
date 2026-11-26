<script lang="ts">
    import TeamRoute from "#lib/components/TeamRoute.svelte";
    import { page } from "$app/state";
    import { goto } from "$app/navigation";
    import KeyPanel from "#lib/components/KeyPanel.svelte";
</script>

<TeamRoute>
    {#snippet children(id, teamUrl)}
        {#key page.url.pathname}<KeyPanel
                {id}
                pubkey={page.params.pubkey ?? ""}
                onBack={() => void goto(teamUrl)}
            />{/key}
    {/snippet}
</TeamRoute>
