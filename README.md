# DIBBS RFQ Browser

Pulls the daily Request-for-Quotation lists from DIBBS (https://www.dibbs.bsm.dla.mil/rfq/)
into Postgres and gives vendors a fast page to search and filter them. Every row links back
to its page on DIBBS.

Full design notes and the reasoning behind every decision: [DOCS.md](DOCS.md).

## Run it

Needs Node 20+ and Docker (the scripts use `sudo docker`).

```bash
npm install        # installs the only dependency (pg)
npm run db         # starts Postgres 16 in Docker on localhost:5434 and creates the tables
npm run pull       # downloads the last ~23 days of RFQs from DIBBS (about 30 seconds)
npm start          # web UI on http://localhost:8787
```

Run `npm run pull` again any time; it only downloads days it has not seen.
`node pull.js --all` re-downloads everything.

## Files

- `db.sh` + `schema.sql` – database
- `pull.js` – download and parse DIBBS daily index files
- `server.js` – JSON API and static page
- `index.html` – the UI
