import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export function generatePdfReport(database, groupId) {
  const model = database.getReportModel(groupId);
  const projectName = basename(process.cwd());
  const schoolName = model.groupName || "School";
  const title = `${projectName} — ${schoolName}`;
  const lines = [
    title,
    `Locked window: ${model.windowStart} to ${model.windowEnd}`,
    "",
  ];

  for (const section of model.sections) {
    lines.push(`${section.label}: ${section.title} (${section.posts.length} posts)`, "");
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
    `id: ${post.id}`,
    `created: ${post.created_at}; alias: ${post.alias ?? ""}; votes: ${post.vote_total ?? ""}; comments: ${post.comment_count ?? ""}`,
    `text: ${post.text || ""}`,
    `metadata: ${post.metadata_json}`,
  ];
}

function buildPdf(lines) {
  const pages = paginate(lines.flatMap(wrapLine));
  const objects = new Map();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  const pageObjectIds = pages.map((_, index) => 4 + index * 2);
  objects.set(2, `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  pages.forEach((page, index) => {
    const pageObjectId = pageObjectIds[index];
    const contentObjectId = pageObjectId + 1;
    const content = [
      "BT",
      "/F1 9 Tf",
      "40 752 Td",
      "11 TL",
      ...page.map((line) => `(${escapePdfText(line)}) Tj T*`),
      "ET",
    ].join("\n");
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

function wrapLine(line) {
  const text = printableText(line);
  const width = 92;
  if (text.length <= width) return [text];
  const chunks = [];
  for (let index = 0; index < text.length; index += width) chunks.push(text.slice(index, index + width));
  return chunks;
}

function printableText(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "?");
}

function escapePdfText(value) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function safeFileName(value) {
  return printableText(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "school";
}
