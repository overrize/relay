// Unit tests use injected price responses; never fetch live vendor prices implicitly.
process.env.SPAWN_PRICE_AUTO_SYNC='0';
