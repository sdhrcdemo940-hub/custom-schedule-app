// One-time backfill: record each Work Order's production line in its description.
//
// Why this is needed
// ------------------
// Work Orders created before the scheduler started stamping workstations have no
// `[WORKSTATION: x]` tag. They only show up on the right calendar row if a Job Card was
// created against them, because Job Cards are the only place ERPNext exposes the line via
// the list API. So older Work Orders that already have a workstation on their operations
// child table were rendering in the "Unassigned" column.
//
// This script reads the first operation's workstation from each affected Work Order and
// writes it into the description as a tag, which is what /api/schedule reads.
//
// It is idempotent and only ever fills in missing tags. It does not touch the operations
// child table, quantities, dates, statuses, or the user's own description text.
//
// Usage
// -----
//   node scripts/backfill-workstations.js           # dry run, changes nothing
//   node scripts/backfill-workstations.js --apply   # actually write the tags

require('dotenv').config();

const axios = require('axios');
const {
  parseBatchTag,
  parseWorkstationTag,
  composeDescription,
  stripManagedTags,
  firstOperationWorkstation
} = require('../lib/description-tags');

const APPLY = process.argv.includes('--apply');
const ERPNEXT_URL = process.env.ERPNEXT_URL || 'http://localhost:8080';
const PAGE = 200;

const api = axios.create({
  baseURL: `${ERPNEXT_URL}/api/resource`,
  timeout: 120000,
  headers: {
    Authorization: `token ${process.env.ERPNEXT_API_KEY}:${process.env.ERPNEXT_API_SECRET}`,
    'Content-Type': 'application/json'
  }
});

const detail = (error) => {
  const data = error.response && error.response.data;
  if (data && data._server_messages) return data._server_messages;
  if (data && data.exception) return `${data.exception}: ${data.exc_type || ''}`;
  if (data && data.message) return data.message;
  return error.message;
};

// Frappe caps limit_page_length, so page through the whole doctype.
const fetchAll = async (doctype, fields) => {
  const rows = [];
  for (let start = 0; ; start += PAGE) {
    const response = await api.get(`/${encodeURIComponent(doctype)}`, {
      params: {
        fields: JSON.stringify(fields),
        filters: JSON.stringify([['docstatus', '!=', 2]]),
        order_by: 'name asc',
        limit_start: start,
        limit_page_length: PAGE
      }
    });
    const page = response.data.data || [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
};

const main = async () => {
  console.log(`ERPNext  : ${ERPNEXT_URL}`);
  console.log(`Mode     : ${APPLY ? 'APPLY (will write to ERPNext)' : 'DRY RUN (no changes)'}`);
  console.log('');

  const [workOrders, jobCards] = await Promise.all([
    fetchAll('Work Order', ['name', 'description']),
    fetchAll('Job Card', ['work_order', 'workstation'])
  ]);

  // A Job Card is ERPNext's own record of the line, so it wins over the backfilled tag.
  const fromJobCard = new Map();
  jobCards.forEach((jc) => {
    if (jc.work_order && jc.workstation && !fromJobCard.has(jc.work_order)) {
      fromJobCard.set(jc.work_order, jc.workstation);
    }
  });

  const candidates = workOrders.filter((wo) => {
    if (fromJobCard.has(wo.name)) return false;
    if (parseWorkstationTag(wo.description)) return false;
    return true;
  });

  console.log(`Work Orders total          : ${workOrders.length}`);
  console.log(`Resolved by Job Card       : ${workOrders.length - candidates.length}`);
  console.log(`Needing a backfilled tag   : ${candidates.length}`);
  console.log('');

  const tagged = [];
  const unresolvable = [];

  for (const wo of candidates) {
    let doc;
    try {
      const response = await api.get(`/Work Order/${encodeURIComponent(wo.name)}`);
      doc = response.data.data;
    } catch (error) {
      unresolvable.push({ name: wo.name, reason: `could not read: ${detail(error)}` });
      continue;
    }

    const workstation = firstOperationWorkstation(doc);
    if (!workstation) {
      unresolvable.push({
        name: wo.name,
        reason: (Array.isArray(doc.operations) && doc.operations.length)
          ? 'no workstation set on any operation'
          : 'no operations'
      });
      continue;
    }

    // Preserve the batch tag and the user's own text; only add/replace the workstation tag.
    const description = composeDescription({
      batch: parseBatchTag(doc.description),
      workstation,
      userDescription: stripManagedTags(doc.description)
    });

    if (APPLY) {
      try {
        await api.put(`/Work Order/${encodeURIComponent(wo.name)}`, { description });
      } catch (error) {
        unresolvable.push({ name: wo.name, reason: `could not write: ${detail(error)}` });
        continue;
      }
    }

    tagged.push({ name: wo.name, workstation });
    console.log(`  ${APPLY ? 'tagged' : 'would tag'}  ${wo.name} -> ${workstation}`);
  }

  console.log('');
  console.log(`${APPLY ? 'Tagged' : 'Would tag'}  : ${tagged.length}`);
  console.log(`Unresolved: ${unresolvable.length}`);

  if (unresolvable.length) {
    console.log('');
    console.log('These need a decision and were left untouched:');
    unresolvable.forEach((row) => console.log(`  ${row.name}  (${row.reason})`));
  }

  if (!APPLY && tagged.length) {
    console.log('');
    console.log('This was a dry run. Re-run with --apply to write the tags.');
  }
};

main().catch((error) => {
  console.error('Backfill failed:', detail(error));
  process.exit(1);
});
