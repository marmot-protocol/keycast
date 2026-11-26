-- Current fresh-install defaults: nos.lol and Primal (Damus removed).
-- Keep applied migrations immutable and preserve routes already issued to clients.
-- Only prune Damus from the untouched bootstrap set before any grant has been created.
DELETE FROM relays
WHERE url='wss://relay.damus.io' AND enabled=1 AND sort_order=30 AND discovered=0
AND NOT EXISTS(SELECT 1 FROM grants)
AND (SELECT count(*) FROM relays)=3
AND (SELECT minimum_connected_relays FROM instance_settings WHERE singleton=1)<=2
AND EXISTS(SELECT 1 FROM relays WHERE url='wss://nos.lol' AND enabled=1 AND sort_order=10 AND discovered=0)
AND EXISTS(SELECT 1 FROM relays WHERE url='wss://relay.primal.net' AND enabled=1 AND sort_order=20 AND discovered=0);
