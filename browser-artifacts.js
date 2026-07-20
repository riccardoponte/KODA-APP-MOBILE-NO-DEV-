const TYPE_CONFIG = Object.freeze({
    txt: { extension: 'txt', mime: 'text/plain;charset=utf-8' },
    md: { extension: 'md', mime: 'text/markdown;charset=utf-8' },
    html: { extension: 'html', mime: 'text/html;charset=utf-8' },
    csv: { extension: 'csv', mime: 'text/csv;charset=utf-8' },
    json: { extension: 'json', mime: 'application/json;charset=utf-8' },
    doc: { extension: 'doc', mime: 'application/msword' },
    pdf: { extension: 'pdf', mime: 'application/pdf' },
    xlsx: { extension: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
});

const encoder = new TextEncoder();

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
})[character]);

const escapeXML = value => escapeHTML(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const normalizeType = value => Object.prototype.hasOwnProperty.call(TYPE_CONFIG, value) ? value : 'txt';

const safeFileName = (value, type) => {
    const config = TYPE_CONFIG[type];
    const stem = String(value || 'koda-file')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'koda-file';
    const withoutExtension = stem.replace(/\.[a-z0-9]{1,5}$/i, '');
    return `${withoutExtension}.${config.extension}`;
};

const normalizeArtifact = artifact => {
    const type = normalizeType(artifact?.type);
    return {
        type,
        name: safeFileName(artifact?.name, type),
        content: String(artifact?.content ?? '').slice(0, 100000)
    };
};

const formatInlineMarkdown = value => escapeHTML(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');

const markdownToHTML = markdown => {
    const lines = String(markdown || '').replace(/\r/g, '').split('\n');
    const output = [];
    let listType = '';
    let paragraph = [];

    const closeParagraph = () => {
        if (!paragraph.length) return;
        output.push(`<p>${paragraph.map(formatInlineMarkdown).join('<br>')}</p>`);
        paragraph = [];
    };
    const closeList = () => {
        if (!listType) return;
        output.push(`</${listType}>`);
        listType = '';
    };

    for (const line of lines) {
        const heading = line.match(/^(#{1,4})\s+(.+)$/);
        const unordered = line.match(/^\s*[-*]\s+(.+)$/);
        const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
        if (heading) {
            closeParagraph();
            closeList();
            const level = heading[1].length;
            output.push(`<h${level}>${formatInlineMarkdown(heading[2])}</h${level}>`);
        } else if (unordered || ordered) {
            closeParagraph();
            const nextListType = unordered ? 'ul' : 'ol';
            if (listType !== nextListType) {
                closeList();
                listType = nextListType;
                output.push(`<${listType}>`);
            }
            output.push(`<li>${formatInlineMarkdown((unordered || ordered)[1])}</li>`);
        } else if (!line.trim()) {
            closeParagraph();
            closeList();
        } else {
            closeList();
            paragraph.push(line);
        }
    }
    closeParagraph();
    closeList();
    return output.join('\n');
};

const detectDelimiter = line => {
    const options = [',', ';', '\t'];
    return options.sort((left, right) => line.split(right).length - line.split(left).length)[0];
};

const parseDelimitedLine = (line, delimiter) => {
    const cells = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (quoted && character === '"' && line[index + 1] === '"') {
            value += '"';
            index += 1;
        } else if (character === '"') {
            quoted = !quoted;
        } else if (character === delimiter && !quoted) {
            cells.push(value.trim());
            value = '';
        } else {
            value += character;
        }
    }
    cells.push(value.trim());
    return cells;
};

const parseTable = content => {
    const lines = String(content || '').replace(/\r/g, '').split('\n').filter(line => line.trim());
    if (!lines.length) return [['Value'], ['']];

    const markdownRows = lines.filter(line => line.includes('|'));
    if (markdownRows.length >= 2) {
        const rows = markdownRows
            .filter(line => !/^\s*\|?\s*:?-{2,}/.test(line) || !/^[\s|:-]+$/.test(line))
            .map(line => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim()));
        if (rows.length) return rows;
    }

    const delimiter = detectDelimiter(lines[0]);
    return lines.map(line => parseDelimitedLine(line, delimiter));
};

const tableToHTML = rows => {
    const columnCount = Math.max(1, ...rows.map(row => row.length));
    const normalized = rows.map(row => Array.from({ length: columnCount }, (_, index) => row[index] ?? ''));
    const head = normalized[0].map(cell => `<th>${escapeHTML(cell)}</th>`).join('');
    const body = normalized.slice(1).map(row => `<tr>${row.map(cell => `<td>${escapeHTML(cell)}</td>`).join('')}</tr>`).join('');
    return `<div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
};

let crcTable = null;
const crc32 = bytes => {
    if (!crcTable) {
        crcTable = Array.from({ length: 256 }, (_, index) => {
            let value = index;
            for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
            return value >>> 0;
        });
    }
    let checksum = 0xffffffff;
    for (const byte of bytes) checksum = crcTable[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
    return (checksum ^ 0xffffffff) >>> 0;
};

const concatenate = chunks => {
    const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
};

const zipStored = entries => {
    const localChunks = [];
    const centralChunks = [];
    let localOffset = 0;

    for (const entry of entries) {
        const name = encoder.encode(entry.name);
        const data = entry.data instanceof Uint8Array ? entry.data : encoder.encode(entry.data);
        const checksum = crc32(data);
        const local = new Uint8Array(30);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(6, 0x0800, true);
        localView.setUint32(14, checksum, true);
        localView.setUint32(18, data.length, true);
        localView.setUint32(22, data.length, true);
        localView.setUint16(26, name.length, true);
        localChunks.push(local, name, data);

        const central = new Uint8Array(46);
        const centralView = new DataView(central.buffer);
        centralView.setUint32(0, 0x02014b50, true);
        centralView.setUint16(4, 20, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint16(8, 0x0800, true);
        centralView.setUint32(16, checksum, true);
        centralView.setUint32(20, data.length, true);
        centralView.setUint32(24, data.length, true);
        centralView.setUint16(28, name.length, true);
        centralView.setUint32(42, localOffset, true);
        centralChunks.push(central, name);
        localOffset += local.length + name.length + data.length;
    }

    const centralDirectory = concatenate(centralChunks);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, centralDirectory.length, true);
    endView.setUint32(16, localOffset, true);
    return concatenate([...localChunks, centralDirectory, end]);
};

const spreadsheetColumn = index => {
    let result = '';
    let value = index + 1;
    while (value > 0) {
        result = String.fromCharCode(65 + (value - 1) % 26) + result;
        value = Math.floor((value - 1) / 26);
    }
    return result;
};

const buildXLSX = content => {
    const rows = parseTable(content);
    const sheetRows = rows.map((row, rowIndex) => {
        const cells = row.map((cell, columnIndex) => {
            const reference = `${spreadsheetColumn(columnIndex)}${rowIndex + 1}`;
            const value = String(cell).trim();
            if (/^-?\d+(?:[.,]\d+)?$/.test(value)) {
                return `<c r="${reference}"><v>${value.replace(',', '.')}</v></c>`;
            }
            return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXML(cell)}</t></is></c>`;
        }).join('');
        return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join('');
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
    const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Koda" sheetId="1" r:id="rId1"/></sheets></workbook>';
    const workbookRelationships = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
    const rootRelationships = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
    return zipStored([
        { name: '[Content_Types].xml', data: contentTypes },
        { name: '_rels/.rels', data: rootRelationships },
        { name: 'xl/workbook.xml', data: workbook },
        { name: 'xl/_rels/workbook.xml.rels', data: workbookRelationships },
        { name: 'xl/worksheets/sheet1.xml', data: sheet }
    ]);
};

const markdownToPlainText = content => String(content || '')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .trim();

const toPDFASCII = value => String(value)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u20ac/g, 'EUR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E\n]/g, '?');

const wrapText = (text, width = 88) => {
    const lines = [];
    for (const sourceLine of text.split('\n')) {
        if (!sourceLine.trim()) {
            lines.push('');
            continue;
        }
        const words = sourceLine.trim().split(/\s+/);
        let line = '';
        for (const word of words) {
            if (word.length > width) {
                if (line) lines.push(line);
                for (let index = 0; index < word.length; index += width) lines.push(word.slice(index, index + width));
                line = '';
            } else if (!line) {
                line = word;
            } else if (line.length + word.length + 1 <= width) {
                line += ` ${word}`;
            } else {
                lines.push(line);
                line = word;
            }
        }
        if (line) lines.push(line);
    }
    return lines;
};

const buildPDF = content => {
    const lines = wrapText(toPDFASCII(markdownToPlainText(content)) || 'Koda AI document');
    const linesPerPage = 50;
    const pages = Array.from({ length: Math.max(1, Math.ceil(lines.length / linesPerPage)) }, (_, index) =>
        lines.slice(index * linesPerPage, (index + 1) * linesPerPage));
    const fontId = 3 + pages.length * 2;
    const objects = new Array(fontId + 1);
    const pageIds = pages.map((_, index) => 3 + index * 2);
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
    pages.forEach((pageLines, index) => {
        const pageId = pageIds[index];
        const contentId = pageId + 1;
        const commands = pageLines.map(line => `(${line.replace(/([\\()])/g, '\\$1')}) Tj T*`).join('\n');
        const stream = `BT\n/F1 11 Tf\n50 790 Td\n14 TL\n${commands}\nET`;
        objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`;
        objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    });
    objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

    let pdf = '%PDF-1.4\n%KODA\n';
    const offsets = [0];
    for (let id = 1; id <= fontId; id += 1) {
        offsets[id] = pdf.length;
        pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${fontId + 1}\n0000000000 65535 f \n`;
    for (let id = 1; id <= fontId; id += 1) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return encoder.encode(pdf);
};

const wordDocument = content => `<!doctype html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>Koda document</title><style>body{font:12pt/1.5 Calibri,Arial,sans-serif;color:#111;margin:36pt}h1{font-size:20pt}h2{font-size:16pt}h3{font-size:13pt}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:5pt;text-align:left}</style></head><body>${markdownToHTML(content)}</body></html>`;

const previewShell = body => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:"><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;padding:24px;background:#171817;color:#f2f4f2;font:14px/1.6 Montserrat,Arial,sans-serif}main{max-width:920px;margin:auto}h1,h2,h3,h4{line-height:1.25;color:#fff}a{color:#55d681}code,pre{font-family:Consolas,monospace}code{background:#272a28;padding:2px 5px;border-radius:4px}pre{white-space:pre-wrap;word-break:break-word;background:#101110;border:1px solid #343734;border-radius:6px;padding:14px}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse}th,td{border:1px solid #3e423f;padding:8px 10px;text-align:left}th{background:#252825;color:#fff}</style></head><body><main>${body}</main></body></html>`;

const sanitizeGeneratedHTML = content => {
    if (typeof DOMParser === 'undefined') return previewShell(`<pre>${escapeHTML(content)}</pre>`);
    const parsed = new DOMParser().parseFromString(String(content), 'text/html');
    parsed.querySelectorAll('script, iframe, object, embed, link, base, form, input, button, textarea, select, meta[http-equiv]').forEach(node => node.remove());
    parsed.querySelectorAll('*').forEach(element => {
        for (const attribute of [...element.attributes]) {
            const name = attribute.name.toLowerCase();
            const value = attribute.value.trim();
            if (name.startsWith('on') || name === 'srcdoc') element.removeAttribute(attribute.name);
            if ((name === 'src' || name === 'poster') && !/^data:image\//i.test(value)) element.removeAttribute(attribute.name);
            if (name === 'href') {
                try {
                    const url = new URL(value, 'https://koda.invalid/');
                    if (!['http:', 'https:'].includes(url.protocol)) element.removeAttribute(attribute.name);
                    else {
                        element.setAttribute('target', '_blank');
                        element.setAttribute('rel', 'noopener noreferrer');
                    }
                } catch (error) {
                    element.removeAttribute(attribute.name);
                }
            }
            if (name === 'style') element.setAttribute('style', value.replace(/url\s*\([^)]*\)/gi, 'none'));
        }
    });
    parsed.querySelectorAll('style').forEach(style => {
        style.textContent = style.textContent.replace(/@import[^;]+;?/gi, '').replace(/url\s*\([^)]*\)/gi, 'none');
    });
    const styles = [...parsed.head.querySelectorAll('style')].map(style => style.outerHTML).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:">${styles}</head><body>${parsed.body.innerHTML}</body></html>`;
};

const previewHTML = artifact => {
    if (artifact.type === 'html') return sanitizeGeneratedHTML(artifact.content);
    if (artifact.type === 'csv' || artifact.type === 'xlsx') return previewShell(tableToHTML(parseTable(artifact.content)));
    if (artifact.type === 'md' || artifact.type === 'doc' || artifact.type === 'pdf') return previewShell(markdownToHTML(artifact.content));
    return previewShell(`<pre>${escapeHTML(artifact.content)}</pre>`);
};

export function buildArtifactBlob(rawArtifact) {
    const artifact = normalizeArtifact(rawArtifact);
    const config = TYPE_CONFIG[artifact.type];
    if (artifact.type === 'xlsx') return new Blob([buildXLSX(artifact.content)], { type: config.mime });
    if (artifact.type === 'pdf') return new Blob([buildPDF(artifact.content)], { type: config.mime });
    if (artifact.type === 'doc') return new Blob(['\ufeff', wordDocument(artifact.content)], { type: config.mime });
    const prefix = artifact.type === 'csv' ? '\ufeff' : '';
    return new Blob([prefix, artifact.content], { type: config.mime });
}

export function downloadArtifact(rawArtifact) {
    const artifact = normalizeArtifact(rawArtifact);
    const url = URL.createObjectURL(buildArtifactBlob(artifact));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = artifact.name;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createArtifactPreview(rawArtifact) {
    const artifact = normalizeArtifact(rawArtifact);
    const blob = artifact.type === 'pdf'
        ? buildArtifactBlob(artifact)
        : new Blob([previewHTML(artifact)], { type: 'text/html;charset=utf-8' });
    return {
        name: artifact.name,
        type: artifact.type,
        url: URL.createObjectURL(blob)
    };
}

export function revokeArtifactPreview(preview) {
    if (preview?.url) URL.revokeObjectURL(preview.url);
}

export const supportedArtifactTypes = Object.freeze(Object.keys(TYPE_CONFIG));