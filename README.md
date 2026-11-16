# Five-Way Trading League

Site: `docs/` (GitHub Pages). API: `worker/` (Cloudflare Worker + KV).
Deploy the API with `cd worker && npx wrangler@4.20.0 deploy`.

## Replying to a suggestion
```
cd worker
npx wrangler@4.20.0 d1 execute trading-league --remote --command "SELECT id, author, text FROM suggestions WHERE reply IS NULL"
npx wrangler@4.20.0 d1 execute trading-league --remote --command "UPDATE suggestions SET reply = 'Done!', repliedAt = unixepoch()*1000 WHERE id = '<id>'"
```
