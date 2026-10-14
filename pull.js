// pull.js  -  downloads the daily DIBBS RFQ lists and saves them in Postgres.
//
// What it does, step by step:
//   1. open https://www.dibbs.bsm.dla.mil//rfq/
//   2. DIBBS answers with a "DoD Warning and Consent" page. We press its OK button.
//   3. open the "Recent RFQs" page. It links one index file per day (in261013.txt = 2026-10-13).
//   4. download every index file we have not seen yet.
//   5. every line of a file is one RFQ. Cut the line into columns (fixed widths) and save it.
//
// Run:  node pull.js          (only new files)
//       node pull.js --all    (download every file again)

const { Client } = require("pg");

const START_URL = "https://www.dibbs.bsm.dla.mil//rfq/";
const RECENT_URL = "https://www.dibbs.bsm.dla.mil/Rfq/RfqDates.aspx?category=recent";
const DB_URL = "postgres://dibbs:dibbs@localhost:5434/dibbs";

// ---------------------------------------------------------------------------
// A very small cookie jar.
// Node's fetch() forgets cookies between calls. DIBBS needs them: the consent
// click is remembered in a cookie. We keep one list of cookies per host.
// ---------------------------------------------------------------------------
const cookieJar = {}; // { "www.dibbs.bsm.dla.mil": { SessionId: "abc", ... } }

function rememberCookies(url, response) {
  const host = new URL(url).host;
  if (!cookieJar[host]) cookieJar[host] = {};
  for (const line of response.headers.getSetCookie()) {
    const nameAndValue = line.split(";")[0]; // "name=value; Path=/; ..." -> "name=value"
    const eq = nameAndValue.indexOf("=");
    const name = nameAndValue.slice(0, eq).trim();
    const value = nameAndValue.slice(eq + 1).trim();
    cookieJar[host][name] = value;
  }
}

function cookieHeader(url) {
  const host = new URL(url).host;
  const jar = cookieJar[host] || {};
  const parts = [];
  for (const name in jar) parts.push(name + "=" + jar[name]);
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// request(): fetch one URL, follow redirects by hand (so we can save cookies
// from every hop) and return the final page as text.
// ---------------------------------------------------------------------------
async function request(url, method, body) {
  for (let hop = 0; hop < 10; hop++) {
    const headers = {
      "User-Agent": "Mozilla/5.0 (dibbs-rfq-browser)",
      Cookie: cookieHeader(url),
    };
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";

    const response = await fetch(url, { method, headers, body, redirect: "manual" });
    rememberCookies(url, response);

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url).href; // go where the redirect points, as a plain GET
      method = "GET";
      body = undefined;
      continue;
    }

    const bytes = await response.arrayBuffer();
    const text = new TextDecoder("latin1").decode(bytes); // DIBBS sends ISO-8859-1
    return { url: url, text: text, status: response.status };
  }
  throw new Error("too many redirects for " + url);
}

// ---------------------------------------------------------------------------
// The DoD consent page.
// It is a normal HTML form with ~30 hidden inputs and an OK button called
// butAgree. We copy every input into a POST and send it to the form's action.
// ---------------------------------------------------------------------------
function isConsentPage(text) {
  return text.includes("Warning and Consent");
}

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function clickOkOnConsentPage(page) {
  const form = new URLSearchParams();
  const inputs = page.text.match(/<input[^>]*>/g) || [];
  for (const tag of inputs) {
    const name = tag.match(/name="([^"]*)"/);
    const value = tag.match(/value="([^"]*)"/);
    if (name) form.append(name[1], decodeHtml(value ? value[1] : ""));
  }
  const action = page.text.match(/<form[^>]*action="([^"]*)"/)[1];
  const postUrl = new URL(decodeHtml(action), page.url).href;
  return request(postUrl, "POST", form.toString());
}

// getPage(): GET a URL. If DIBBS shows the consent page instead, press OK
// (which redirects us to the page we wanted) and return that.
async function getPage(url) {
  let page = await request(url, "GET");
  if (isConsentPage(page.text)) {
    console.log("   (consent page shown, pressing OK)");
    page = await clickOkOnConsentPage(page);
    if (isConsentPage(page.text)) throw new Error("DIBBS kept showing the consent page for " + url);
  }
  return page;
}

// ---------------------------------------------------------------------------
// Parsing one line of an index file.
// Every line is exactly 140 characters. The column widths come from the DIBBS
// help page "RFQs Download Help" (Rfq/RfqFileDefs.aspx). Example line:
//
// SPE1C126Q05248345002929415         ...         701743027210/20/26SPE1C126Q0524.pdf  0000100EAPLATE,AUTOMOBILE,IN  DQV00G1N000
// |solicit.    |nsn (46 wide)                   |pr          |retby  |file name (19)      |qty    |un|nomenclature (21)   |buyer|AMSC|item|set|pct
// ---------------------------------------------------------------------------
function toIsoDate(mmddyy) {
  // "10/20/26" -> "2026-10-20"
  const mm = mmddyy.slice(0, 2);
  const dd = mmddyy.slice(3, 5);
  const yy = mmddyy.slice(6, 8);
  return "20" + yy + "-" + mm + "-" + dd;
}

function parseLine(line, postedDate) {
  const cut = (start, width) => line.substr(start, width).trim();
  const nsn = cut(13, 46);
  const itemType = cut(135, 1); // 1 = NSN, 2 = part number
  return {
    solicitation: cut(0, 13),
    nsn: nsn,
    fsc: itemType === "1" ? nsn.slice(0, 4) : "", // a part number has no Federal Supply Class
    pr: cut(59, 13),
    return_by: toIsoDate(cut(72, 8)),
    file_name: cut(80, 19),
    qty: parseInt(cut(99, 7), 10),
    unit: cut(106, 2),
    nomenclature: cut(108, 21),
    buyer_code: cut(129, 5),
    amsc: cut(134, 1),
    item_type: itemType,
    set_aside: cut(136, 1) || "N", // DIBBS: blank means "Unrestricted / Not Set-Aside"
    set_aside_pct: cut(137, 3),
    sol_type: line.charAt(8),
    posted_date: postedDate,
  };
}

// ---------------------------------------------------------------------------
// Saving to the database.
// Same (solicitation, pr) seen again -> update the row instead of failing.
// ---------------------------------------------------------------------------
const INSERT_SQL = `
  INSERT INTO rfqs (solicitation, pr, nsn, fsc, nomenclature, qty, unit, return_by, posted_date,
                    file_name, buyer_code, amsc, item_type, set_aside, set_aside_pct, sol_type)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
  ON CONFLICT (solicitation, pr) DO UPDATE SET
    nsn = EXCLUDED.nsn, fsc = EXCLUDED.fsc, nomenclature = EXCLUDED.nomenclature,
    qty = EXCLUDED.qty, unit = EXCLUDED.unit, return_by = EXCLUDED.return_by,
    posted_date = EXCLUDED.posted_date, file_name = EXCLUDED.file_name,
    buyer_code = EXCLUDED.buyer_code, amsc = EXCLUDED.amsc, item_type = EXCLUDED.item_type,
    set_aside = EXCLUDED.set_aside, set_aside_pct = EXCLUDED.set_aside_pct, sol_type = EXCLUDED.sol_type
`;

async function saveFile(db, fileName, text) {
  // in261013.txt -> 2026-10-13
  const postedDate = "20" + fileName.slice(2, 4) + "-" + fileName.slice(4, 6) + "-" + fileName.slice(6, 8);

  const lines = text.split(/\r?\n/).filter((line) => line.length >= 140);

  await db.query("BEGIN");
  for (const line of lines) {
    const r = parseLine(line, postedDate);
    await db.query(INSERT_SQL, [
      r.solicitation, r.pr, r.nsn, r.fsc, r.nomenclature, r.qty, r.unit, r.return_by, r.posted_date,
      r.file_name, r.buyer_code, r.amsc, r.item_type, r.set_aside, r.set_aside_pct, r.sol_type,
    ]);
  }
  await db.query(
    "INSERT INTO pulled_files (file_name, row_count, pulled_at) VALUES ($1, $2, now()) " +
      "ON CONFLICT (file_name) DO UPDATE SET row_count = EXCLUDED.row_count, pulled_at = now()",
    [fileName, lines.length]
  );
  await db.query("COMMIT");
  return lines.length;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const pullEverything = process.argv.includes("--all");

  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  console.log("1. opening " + START_URL);
  await getPage(START_URL);

  console.log("2. opening the Recent RFQs page");
  const recent = await getPage(RECENT_URL);
  const found = recent.text.match(/https:\/\/dibbs2\.bsm\.dla\.mil\/Downloads\/RFQ\/Archive\/in\d{6}\.txt/g) || [];
  const fileUrls = [...new Set(found)].sort(); // oldest first
  console.log("   found " + fileUrls.length + " daily index files");

  let totalRows = 0;
  for (const url of fileUrls) {
    const fileName = url.split("/").pop();

    if (!pullEverything) {
      const seen = await db.query("SELECT 1 FROM pulled_files WHERE file_name = $1", [fileName]);
      if (seen.rows.length > 0) {
        console.log("   skip " + fileName + " (already pulled)");
        continue;
      }
    }

    console.log("3. downloading " + fileName);
    const page = await getPage(url);
    const rows = await saveFile(db, fileName, page.text);
    totalRows += rows;
    console.log("   saved " + rows + " rows");
  }

  const count = await db.query("SELECT count(*) AS n FROM rfqs");
  console.log("done. " + totalRows + " rows pulled this run, " + count.rows[0].n + " rows in the database.");
  await db.end();
}

main().catch((err) => {
  console.error("pull failed:", err.message);
  process.exit(1);
});
