// server.js  -  a tiny web server with two JSON endpoints and one HTML page.
//
//   GET /                 -> index.html (the browser UI)
//   GET /api/rfqs?...     -> search + filter the rfqs table, 50 rows per page
//   GET /api/filters      -> the values the UI shows in its filter dropdowns
//
// Run:  node server.js     then open http://localhost:8787

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const PORT = 8787;
const PAGE_SIZE = 50;
const DB_URL = "postgres://dibbs:dibbs@localhost:5434/dibbs";

const db = new Client({ connectionString: DB_URL });

// ---------------------------------------------------------------------------
// /api/rfqs
// Every filter adds one line to the WHERE list and its value to the params
// list. Values always go in as $1, $2 ... so nobody can inject SQL.
// ---------------------------------------------------------------------------
async function searchRfqs(query) {
  const where = [];
  const params = [];

  function add(sqlWithQuestionMark, value) {
    params.push(value);
    where.push(sqlWithQuestionMark.replace("?", "$" + params.length));
  }

  // free text search over the 4 columns a vendor would type
  const q = (query.get("q") || "").trim();
  if (q) {
    params.push("%" + q.replace(/-/g, "") + "%"); // NSN / solicitation are stored without dashes
    const noDashes = "$" + params.length;
    params.push("%" + q + "%");
    const asTyped = "$" + params.length;
    where.push(
      "(solicitation ILIKE " + noDashes + " OR nsn ILIKE " + noDashes +
      " OR pr ILIKE " + noDashes + " OR nomenclature ILIKE " + asTyped + ")"
    );
  }

  // open = quote deadline is today or later. That is the default.
  const status = query.get("status") || "open";
  if (status === "open") where.push("return_by >= CURRENT_DATE");
  if (status === "closed") where.push("return_by < CURRENT_DATE");

  // deadline within N days
  const closingDays = parseInt(query.get("closing_days") || "", 10);
  if (closingDays > 0) add("return_by <= CURRENT_DATE + ?::int", closingDays);

  // set-aside codes, comma separated: "N,Y"
  const setAside = (query.get("set_aside") || "").trim();
  if (setAside) add("set_aside = ANY(?)", setAside.split(","));

  // FSC codes, comma separated: "5306,5310"
  const fsc = (query.get("fsc") || "").replace(/\s/g, "");
  if (fsc) add("fsc = ANY(?)", fsc.split(",").filter((x) => x));

  // one posted day
  const posted = query.get("posted") || "";
  if (posted) add("posted_date = ?", posted);

  // quantity range
  const minQty = parseInt(query.get("min_qty") || "", 10);
  if (minQty >= 0) add("qty >= ?", minQty);
  const maxQty = parseInt(query.get("max_qty") || "", 10);
  if (maxQty >= 0) add("qty <= ?", maxQty);

  // single letter codes
  const solType = query.get("sol_type") || "";
  if (solType) add("sol_type = ?", solType);
  const amsc = query.get("amsc") || "";
  if (amsc) add("amsc = ?", amsc);
  const itemType = query.get("item_type") || "";
  if (itemType) add("item_type = ?", itemType);

  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

  // sorting: only these exact strings are allowed
  const sorts = {
    return_by: "return_by ASC, solicitation ASC",
    posted: "posted_date DESC, solicitation ASC",
    qty_desc: "qty DESC",
    qty_asc: "qty ASC",
    nomenclature: "nomenclature ASC",
    solicitation: "solicitation ASC",
    nsn: "nsn ASC",
  };
  const orderSql = sorts[query.get("sort")] || sorts.return_by;

  const page = Math.max(1, parseInt(query.get("page") || "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const total = await db.query("SELECT count(*)::int AS n FROM rfqs " + whereSql, params);
  const rows = await db.query(
    "SELECT solicitation, pr, nsn, fsc, nomenclature, qty, unit, " +
      "to_char(return_by, 'YYYY-MM-DD') AS return_by, " +
      "to_char(posted_date, 'YYYY-MM-DD') AS posted_date, " +
      "(return_by - CURRENT_DATE) AS days_left, " +
      "file_name, buyer_code, amsc, item_type, set_aside, set_aside_pct, sol_type " +
      "FROM rfqs " + whereSql + " ORDER BY " + orderSql +
      " LIMIT " + PAGE_SIZE + " OFFSET " + offset,
    params
  );

  return { total: total.rows[0].n, page: page, page_size: PAGE_SIZE, rows: rows.rows };
}

// ---------------------------------------------------------------------------
// /api/filters  -  what exists in the data, so dropdowns are never empty/wrong
// ---------------------------------------------------------------------------
async function filterOptions() {
  const setAsides = await db.query(
    "SELECT set_aside, count(*)::int AS n FROM rfqs WHERE return_by >= CURRENT_DATE GROUP BY set_aside ORDER BY n DESC"
  );
  const fscs = await db.query(
    "SELECT fsc, count(*)::int AS n FROM rfqs WHERE return_by >= CURRENT_DATE AND fsc <> '' GROUP BY fsc ORDER BY fsc"
  );
  const days = await db.query(
    "SELECT to_char(posted_date, 'YYYY-MM-DD') AS d, count(*)::int AS n FROM rfqs GROUP BY posted_date ORDER BY posted_date DESC"
  );
  const solTypes = await db.query("SELECT sol_type, count(*)::int AS n FROM rfqs GROUP BY sol_type ORDER BY sol_type");
  const amscs = await db.query("SELECT amsc, count(*)::int AS n FROM rfqs GROUP BY amsc ORDER BY amsc");
  const totals = await db.query(
    "SELECT count(*)::int AS total, count(*) FILTER (WHERE return_by >= CURRENT_DATE)::int AS open, " +
      "to_char(max(posted_date), 'YYYY-MM-DD') AS newest_day FROM rfqs"
  );
  const lastPull = await db.query("SELECT to_char(max(pulled_at), 'YYYY-MM-DD HH24:MI') AS t FROM pulled_files");

  return {
    set_asides: setAsides.rows,
    fscs: fscs.rows,
    days: days.rows,
    sol_types: solTypes.rows,
    amscs: amscs.rows,
    totals: totals.rows[0],
    last_pull: lastPull.rows[0].t,
  };
}

// ---------------------------------------------------------------------------
// the HTTP server
// ---------------------------------------------------------------------------
function sendJson(res, data) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/rfqs") return sendJson(res, await searchRfqs(url.searchParams));
    if (url.pathname === "/api/filters") return sendJson(res, await filterOptions());
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(path.join(__dirname, "index.html")));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

db.connect().then(() => {
  server.listen(PORT, () => console.log("open http://localhost:" + PORT));
});
