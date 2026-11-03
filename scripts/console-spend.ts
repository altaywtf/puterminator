import * as Schema from "effect/Schema";

const CostReport = Schema.Struct({
  data: Schema.Array(Schema.Struct({ results: Schema.Array(Schema.Struct({ amount: Schema.String, workspace_id: Schema.NullOr(Schema.String) })) })),
  has_more: Schema.Boolean,
  next_page: Schema.NullOr(Schema.String),
});

const decode = Schema.decodeUnknownSync(CostReport);

const monthToDateCents = async (adminKey: string, workspace: string, start: string) => {
  let cents = 0;
  let page: string | null = null;

  do {
    const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    url.searchParams.set("starting_at", start);
    url.searchParams.append("group_by[]", "workspace_id");
    url.searchParams.set("limit", "31");

    if (page) url.searchParams.set("page", page);

    const res = await fetch(url, { headers: { "x-api-key": adminKey, "anthropic-version": "2023-06-01" } });

    if (!res.ok) throw new Error(`cost_report ${res.status}: ${await res.text()}`);

    const report = decode(await res.json());

    for (const bucket of report.data) {
      for (const row of bucket.results) if (row.workspace_id === workspace) cents += Number(row.amount);
    }

    page = report.has_more ? report.next_page : null;
  } while (page);

  return cents;
};

const now = new Date();
const month = now.toISOString().slice(0, 7);
const adminKey = process.env.ANTHROPIC_ADMIN_KEY ?? "";
const workspace = process.env.ANTHROPIC_WORKSPACE_ID ?? "";

if (adminKey === "" || workspace === "") {
  console.log("::warning::ANTHROPIC_ADMIN_KEY or ANTHROPIC_WORKSPACE_ID is unset; the pool starts from its own ledger");
} else {
  try {
    const cents = await monthToDateCents(adminKey, workspace, `${month}-01T00:00:00Z`);
    console.log(`CONSOLE_SPEND=${month}:${Math.ceil(cents)}`);
  } catch (error) {
    console.log(`::warning::couldn't read the console spend: ${String(error)}`);
  }
}
