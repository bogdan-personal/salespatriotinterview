-- One row = one line in the DIBBS daily index file = one purchase request on one solicitation.
CREATE TABLE IF NOT EXISTS rfqs (
  solicitation   TEXT NOT NULL,   -- e.g. SPE1C126Q0524 (DIBBS shows it as SPE1C1-26-Q-0524)
  pr             TEXT NOT NULL,   -- purchase request number, e.g. 7017430272
  nsn            TEXT NOT NULL,   -- 13 digit NSN, or a part number when item_type = 2
  fsc            TEXT NOT NULL,   -- Federal Supply Class = first 4 digits of the NSN
  nomenclature   TEXT NOT NULL,   -- short item name, e.g. PLATE,AUTOMOBILE,IN (DIBBS cuts it at 21 chars)
  qty            INTEGER NOT NULL,
  unit           TEXT NOT NULL,   -- unit of issue, e.g. EA, PG, BX
  return_by      DATE NOT NULL,   -- quote deadline
  posted_date    DATE NOT NULL,   -- the day DIBBS posted it (from the file name)
  file_name      TEXT NOT NULL,   -- the PDF name, e.g. SPE1C126Q0524.pdf
  buyer_code     TEXT NOT NULL,
  amsc           TEXT NOT NULL,   -- Acquisition Method Suffix Code, one letter
  item_type      TEXT NOT NULL,   -- 1 = NSN, 2 = part number
  set_aside      TEXT NOT NULL,   -- N, Y, H, R, L, A, E (see DOCS.md)
  set_aside_pct  TEXT NOT NULL,   -- e.g. 000 or 100
  sol_type       TEXT NOT NULL,   -- 9th letter of the solicitation number: Q, T or U
  PRIMARY KEY (solicitation, pr)
);

CREATE INDEX IF NOT EXISTS rfqs_return_by_idx ON rfqs (return_by);
CREATE INDEX IF NOT EXISTS rfqs_posted_date_idx ON rfqs (posted_date);
CREATE INDEX IF NOT EXISTS rfqs_fsc_idx ON rfqs (fsc);

-- Which daily files we already downloaded, so a second run does not download them again.
CREATE TABLE IF NOT EXISTS pulled_files (
  file_name  TEXT PRIMARY KEY,   -- e.g. in261013.txt
  row_count  INTEGER NOT NULL,
  pulled_at  TIMESTAMP NOT NULL DEFAULT now()
);
