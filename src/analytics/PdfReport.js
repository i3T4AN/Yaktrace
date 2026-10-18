import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export function generatePdfReport(database, groupId) {
  const model = database.getReportModel(groupId);
  const projectName = basename(dirname(process.cwd()));
  const schoolName = model.groupName || "School";
  const title = `${projectName} - ${schoolName}`;
  const lines = [
    { type: "cover", title, schoolName, windowStart: model.windowStart, windowEnd: model.windowEnd },
  ];

  for (const [index, section] of model.sections.entries()) {
    lines.push({
      type: "section",
      maskedName: index % 2 === 0 ? "John Doe" : "Jane Doe",
      label: `User-${String(index + 1).padStart(3, "0")}`,
      count: section.posts.length,
    }, "");
    if (section.posts.length === 0) lines.push("No posts.", "");
    for (const post of section.posts) {
      lines.push(...formatPost(post), "");
    }
  }

  const outputDirectory = resolve(process.cwd(), "reports");
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const outputPath = resolve(outputDirectory, `${safeFileName(schoolName)}-report.pdf`);
  writeFileSync(outputPath, buildPdf(lines));
  chmodSync(outputPath, 0o600);
  return outputPath;
}

function formatPost(post) {
  return [
    `POST ID: ${post.id}`,
    `TIMESTAMP (UTC): ${post.created_at}`,
    `UPVOTES: ${upvotes(post)}`,
    `POST: ${post.text || ""}`,
  ];
}

function upvotes(post) {
  try {
    const metadata = JSON.parse(post.metadata_json);
    return metadata.upvote_count ?? metadata.upvotes ?? post.vote_total ?? "";
  } catch {
    return post.vote_total ?? "";
  }
}

function buildPdf(lines) {
  const cover = lines.find((entry) => entry?.type === "cover");
  const body = lines.filter((entry) => entry?.type !== "cover").flatMap(wrapEntry);
  const pages = cover ? [[cover], ...paginate(body)] : paginate(body);
  const objects = new Map();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  const pageObjectIds = pages.map((_, index) => 4 + index * 2);
  objects.set(2, `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  pages.forEach((page, index) => {
    const pageObjectId = pageObjectIds[index];
    const contentObjectId = pageObjectId + 1;
    const content = pageContent(page);
    objects.set(pageObjectId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectId} 0 R >>`);
    objects.set(contentObjectId, `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
  });

  let pdf = "%PDF-1.4\n%PDF\n";
  const offsets = [0];
  for (let id = 1; id <= objects.size; id += 1) {
    offsets[id] = Buffer.byteLength(pdf, "latin1");
    pdf += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.size + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= objects.size; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.size + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function paginate(lines) {
  const pageLength = 63;
  const pages = [];
  for (let index = 0; index < lines.length; index += pageLength) pages.push(lines.slice(index, index + pageLength));
  return pages.length > 0 ? pages : [[""]];
}

function wrapEntry(entry) {
  if (typeof entry !== "string") return [entry];
  return wrapLine(entry);
}

function wrapLine(line) {
  const text = printableText(line);
  const width = 92;
  if (text.length <= width) return [text];
  const chunks = [];
  for (let index = 0; index < text.length; index += width) chunks.push(text.slice(index, index + width));
  return chunks;
}

function pageContent(entries) {
  if (entries.length === 1 && entries[0]?.type === "cover") return coverPageContent(entries[0]);
  let y = 752;
  const commands = ["0 g 0 0 612 792 re f", "1 g"];
  for (const entry of entries) {
    if (entry?.type === "section") {
      const maskedName = printableText(entry.maskedName);
      const maskWidth = maskedName.length * 5.3 + 8;
      const heading = `${entry.label} (${entry.count} posts)`;
      commands.push(
        `1 g 40 ${y - 2} ${maskWidth.toFixed(1)} 11 re f`,
        `1 g BT /F1 9 Tf 44 ${y} Td (${escapePdfText(maskedName)}) Tj ET`,
        `1 g BT /F1 10 Tf ${(44 + maskWidth).toFixed(1)} ${y} Td (${escapePdfText(printableText(heading))}) Tj ET`,
      );
    } else {
      commands.push(`BT /F1 9 Tf 40 ${y} Td (${escapePdfText(entry)}) Tj ET`);
    }
    y -= 11;
  }
  return commands.join("\n");
}

function coverPageContent(cover) {
  const title = printableText(cover.title);
  const releaseLabel = printableText(`${cover.schoolName} FILE RELEASE`);
  const windowStart = printableText(formatUtcTimestamp(cover.windowStart));
  const windowEnd = printableText(formatUtcTimestamp(cover.windowEnd));
  return [
    "0 g 0 0 612 792 re f",
    "1 g BT /F1 10 Tf 48 716 Td (" + escapePdfText(releaseLabel) + ") Tj ET",
    "1 g BT /F1 30 Tf 48 638 Td (" + escapePdfText(title) + ") Tj ET",
    "0.72 g BT /F1 10 Tf 48 548 Td (CAPTURE WINDOW / UTC) Tj ET",
    "1 g BT /F1 12 Tf 48 522 Td (" + escapePdfText(windowStart) + ") Tj ET",
    "1 g BT /F1 12 Tf 48 498 Td (TO) Tj ET",
    "1 g BT /F1 12 Tf 48 474 Td (" + escapePdfText(windowEnd) + ") Tj ET",
    "0.72 g 48 144 516 1 re f",
    "0.72 g BT /F1 9 Tf 48 118 Td (POST-BLOCK DIFFERENCE ANALYSIS: AS ANONYMOUS AS YOU'LL ALLOW YOURSELF TO BE :\\)) Tj ET",
  ].join("\n");
}

function printableText(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[^\x20-\x7E]/g, "?");
}

function escapePdfText(value) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function safeFileName(value) {
  return printableText(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "school";
}

function formatUtcTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date);
}
