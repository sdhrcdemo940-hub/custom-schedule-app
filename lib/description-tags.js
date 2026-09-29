// Structured tags stored in a Work Order's `description` field.
//
// ERPNext keeps a Work Order's production line on the `operations` child table, and that
// child table cannot be read through the REST list API. To keep /api/schedule down to a
// single query per doctype, the chosen line is also recorded as a `[WORKSTATION: x]` tag in
// the description, alongside the `[BATCH-GROUP: ...]` tag.
//
// Shared by server.js and scripts/backfill-workstations.js so the two cannot drift.

const BATCH_TAG_REGEX = /\[BATCH-GROUP:\s*([^\]]+)\]/i;
const WORKSTATION_TAG_REGEX = /\[WORKSTATION:\s*([^\]]+)\]/i;

const parseBatchTag = (description) => {
  if (!description) return null;

  const match = String(description).match(BATCH_TAG_REGEX);
  if (!match) return null;

  const parts = match[1].split('|').map((part) => part.trim());
  const groupId = parts[0];
  if (!groupId || groupId.toLowerCase() === 'pending') return null;

  const rolePart = parts[1] || '';
  const tag = { groupId, role: null, batchNumber: null, batchTotal: null, masterWO: null };

  if (/^master\b/i.test(rolePart)) {
    tag.role = 'master';
    const totalMatch = (parts[2] || '').match(/(\d+)\s*batch/i);
    if (totalMatch) tag.batchTotal = Number(totalMatch[1]);
  } else {
    const batchMatch = rolePart.match(/^batch\s+(\d+)\s*\/\s*(\d+)/i);
    if (batchMatch) {
      tag.role = 'sub';
      tag.batchNumber = Number(batchMatch[1]);
      tag.batchTotal = Number(batchMatch[2]);
    }
  }

  const masterMatch = rolePart.match(/Master:\s*(\S+)/i);
  if (masterMatch) tag.masterWO = masterMatch[1];

  return tag;
};

const buildBatchTag = ({ groupId, role, batchNumber, batchTotal, masterWO }) => {
  if (role === 'master') {
    return `[BATCH-GROUP: ${groupId} | MASTER | ${batchTotal || 0} batches]`;
  }
  const masterPart = masterWO ? ` | Master: ${masterWO}` : '';
  return `[BATCH-GROUP: ${groupId} | Batch ${batchNumber || 1}/${batchTotal || 1}${masterPart}]`;
};

const parseWorkstationTag = (description) => {
  if (!description) return null;
  const match = String(description).match(WORKSTATION_TAG_REGEX);
  return match ? match[1].trim() : null;
};

const buildWorkstationTag = (workstation) => (workstation ? `[WORKSTATION: ${workstation}]` : '');

const composeDescription = ({ batch, workstation, userDescription }) => {
  const head = [batch ? buildBatchTag(batch) : null, buildWorkstationTag(workstation)]
    .filter(Boolean)
    .join('\n');
  const rest = String(userDescription || '').trim();
  return rest ? `${head}\n${rest}` : head;
};

// Everything except the two structured tags, i.e. what the user actually typed.
const stripManagedTags = (description) => {
  if (!description) return '';
  return String(description)
    .replace(BATCH_TAG_REGEX, '')
    .replace(WORKSTATION_TAG_REGEX, '')
    .replace(/^\s*\n/, '')
    .trim();
};

// The production line a Work Order belongs to on the schedule.
// Mirrors the precedence used by /api/schedule.
const firstOperationWorkstation = (doc) => {
  const operations = Array.isArray(doc && doc.operations) ? doc.operations : [];
  const sorted = operations
    .slice()
    .sort((a, b) => (Number(a.idx) || 0) - (Number(b.idx) || 0));
  const match = sorted.find((op) => op && op.workstation);
  return match ? match.workstation : null;
};

module.exports = {
  BATCH_TAG_REGEX,
  WORKSTATION_TAG_REGEX,
  parseBatchTag,
  buildBatchTag,
  parseWorkstationTag,
  buildWorkstationTag,
  composeDescription,
  stripManagedTags,
  firstOperationWorkstation
};
