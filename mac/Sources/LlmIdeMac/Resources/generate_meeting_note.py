#!/usr/bin/env python3
"""
generate_meeting_note.py
Fill note_template.docx with meeting data and write a new .docx file.

No external dependencies — uses only Python stdlib (zipfile, re, json, shutil).

Usage:
  python3 generate_meeting_note.py <template.docx> <output.docx> '<json>'
  echo '<json>' | python3 generate_meeting_note.py <template.docx> <output.docx>

JSON schema:
  {
    "title":        "Meeting title",
    "date":         "2026-05-27 14:00",
    "date_created": "2026-05-27",
    "participants": ["Name1", "Name2"],
    "decisions":    ["Decision 1", "Decision 2"],
    "todos":        [{"task": "Do X", "owner": "Dinesh", "due": "2026-06-03"}],
    "content":      "Full meeting summary / 議事内容",
    "agenda":       ["Topic 1", "Topic 2"],
    "qa":           [{"q": "Question?", "a": "Answer."}]
  }
"""

import sys
import os
import json
import re
import zipfile
import shutil
import tempfile

# ── Word XML namespace ────────────────────────────────────────────────────────
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML_SPACE = 'xml:space="preserve"'

# Run properties copied from the template (MS Mincho, black).
RUN_PROPS = (
    '<w:rPr>'
    '<w:rFonts w:ascii="MS Mincho" w:eastAsia="MS Mincho"'
    ' w:hAnsi="MS Mincho" w:cs="MS Mincho"/>'
    '<w:color w:val="000000" w:themeColor="text1"/>'
    '</w:rPr>'
)

PARA_PROPS = '<w:pPr><w:spacing w:line="260" w:lineRule="exact"/></w:pPr>'


def escape_xml(text: str) -> str:
    return (text
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;"))


def make_para(text: str, indent: bool = False) -> str:
    """Single paragraph containing `text`, preserving spaces."""
    safe = escape_xml(text)
    space = ' xml:space="preserve"' if (" " in text or text != text.strip()) else ""
    pp = PARA_PROPS
    if indent:
        pp = '<w:pPr><w:spacing w:line="260" w:lineRule="exact"/><w:ind w:left="360"/></w:pPr>'
    return (
        f'<w:p>{pp}'
        f'<w:r>{RUN_PROPS}<w:t{space}>{safe}</w:t></w:r>'
        f'</w:p>'
    )


def make_paras(lines: list[str], indent: bool = False) -> str:
    """Multiple paragraphs, one per line."""
    if not lines:
        return make_para("—")
    return "".join(make_para(line, indent) for line in lines)


def replace_cell_content(cell_xml: str, new_paragraphs: str) -> str:
    """
    Replace all <w:p> elements in a cell with `new_paragraphs`,
    leaving <w:tcPr> untouched.
    """
    # Extract cell properties block
    tcp_match = re.search(r'(<w:tcPr>.*?</w:tcPr>)', cell_xml, re.DOTALL)
    tc_pr = tcp_match.group(1) if tcp_match else ""
    return f'<w:tc>{tc_pr}{new_paragraphs}</w:tc>'


def get_rows(table_xml: str) -> list[str]:
    return re.findall(r'<w:tr[ >].*?</w:tr>', table_xml, re.DOTALL)


def get_cells(row_xml: str) -> list[str]:
    return re.findall(r'<w:tc>.*?</w:tc>', row_xml, re.DOTALL)


def put_rows(table_xml: str, rows: list[str]) -> str:
    """Reconstruct table XML with replaced rows."""
    orig_rows = get_rows(table_xml)
    result = table_xml
    for orig, new in zip(orig_rows, rows):
        result = result.replace(orig, new, 1)
    return result


def put_cells(row_xml: str, cells: list[str]) -> str:
    """Reconstruct row XML with replaced cells."""
    orig_cells = get_cells(row_xml)
    result = row_xml
    for orig, new in zip(orig_cells, cells):
        result = result.replace(orig, new, 1)
    return result


def fill_template(template_path: str, output_path: str, data: dict) -> None:
    title        = data.get("title", "Meeting")
    date         = data.get("date", "—")
    date_created = data.get("date_created", "—")
    location     = data.get("location", "—")
    participants = data.get("participants", [])
    decisions    = data.get("decisions", [])
    todos        = data.get("todos", [])
    content      = data.get("content", "—")
    agenda       = data.get("agenda", [])
    qa           = data.get("qa", [])

    # Copy template to output path
    shutil.copy2(template_path, output_path)

    # Read and modify document.xml inside the zip
    with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        with zipfile.ZipFile(output_path, "r") as zin:
            xml = zin.read("word/document.xml").decode("utf-8")
            names = zin.namelist()

        # ── Locate and parse the single table ────────────────────────────
        tbl_match = re.search(r'<w:tbl>.*?</w:tbl>', xml, re.DOTALL)
        if not tbl_match:
            raise ValueError("No table found in template")
        tbl_xml = tbl_match.group(0)
        rows = get_rows(tbl_xml)

        # ── Row 0: Title ─────────────────────────────────────────────────
        r0_cells = get_cells(rows[0])
        r0_cells[0] = replace_cell_content(
            r0_cells[0],
            make_para(title)
        )
        rows[0] = put_cells(rows[0], r0_cells)

        # ── Row 1: 日時 | (date) | 場所 | (location) ───────────────────
        r1_cells = get_cells(rows[1])
        r1_cells[1] = replace_cell_content(r1_cells[1], make_para(date))
        r1_cells[3] = replace_cell_content(r1_cells[3], make_para(location))
        rows[1] = put_cells(rows[1], r1_cells)

        # ── Row 2: 参加者 | project | members ──────────────────────────
        # Replace "project" with first participant, "members" with the rest
        r2_cells = get_cells(rows[2])
        project_part = participants[0] if participants else "—"
        members_part = "、".join(participants[1:]) if len(participants) > 1 else "—"
        r2_cells[1] = replace_cell_content(r2_cells[1], make_para(project_part))
        r2_cells[2] = replace_cell_content(r2_cells[2], make_para(members_part))
        rows[2] = put_cells(rows[2], r2_cells)

        # ── Row 4: 作成者 | (author) | 作成日 | (date_created) ─────────
        r4_cells = get_cells(rows[4])
        r4_cells[1] = replace_cell_content(r4_cells[1], make_para("—"))
        r4_cells[3] = replace_cell_content(r4_cells[3], make_para(date_created))
        rows[4] = put_cells(rows[4], r4_cells)

        # ── Row 7: 決定事項 | (decisions) ───────────────────────────────
        r7_cells = get_cells(rows[7])
        decision_lines = [f"・{d}" for d in decisions] if decisions else ["—"]
        r7_cells[1] = replace_cell_content(
            r7_cells[1], make_paras(decision_lines)
        )
        rows[7] = put_cells(rows[7], r7_cells)

        # ── Rows 8-9: ToDo ───────────────────────────────────────────────
        # Row 8 cell 1 = owner, cell 2 = task description
        # Row 9 cell 1 = owner, cell 2 = task description (second todo)
        todo_rows = [(8, 1, 2), (9, 1, 2)]
        for idx, (row_idx, owner_col, desc_col) in enumerate(todo_rows):
            if row_idx >= len(rows):
                break
            r_cells = get_cells(rows[row_idx])
            if idx < len(todos):
                t = todos[idx]
                owner = t.get("owner", "—")
                due   = t.get("due", "")
                task  = t.get("task", "—")
                owner_text = f"{owner}（期限: {due}）" if due else owner
                r_cells[owner_col] = replace_cell_content(
                    r_cells[owner_col], make_para(owner_text)
                )
                r_cells[desc_col] = replace_cell_content(
                    r_cells[desc_col], make_para(task)
                )
            else:
                r_cells[owner_col] = replace_cell_content(
                    r_cells[owner_col], make_para("—")
                )
                r_cells[desc_col] = replace_cell_content(
                    r_cells[desc_col], make_para("—")
                )
            rows[row_idx] = put_cells(rows[row_idx], r_cells)

        # ── Row 11: アジェンダ | (agenda + 議事内容) ────────────────────
        # Left cell (col 0): agenda bullet items
        # Right cell (col 1): full meeting content
        r11_cells = get_cells(rows[11])
        agenda_lines = [f"・{a}" for a in agenda] if agenda else ["—"]
        r11_cells[0] = replace_cell_content(
            r11_cells[0], make_paras(agenda_lines)
        )
        # 議事内容 goes in col 1 (wide cell, span=4)
        content_lines = content.split("\n") if content else ["—"]
        # Trim markdown headings/bullets for plain text Word output
        cleaned = []
        for line in content_lines:
            line = line.strip()
            if not line:
                continue
            # Strip markdown bold/italic/heading markers
            line = re.sub(r'^#+\s*', '', line)
            line = re.sub(r'\*\*(.*?)\*\*', r'\1', line)
            line = re.sub(r'\*(.*?)\*', r'\1', line)
            line = re.sub(r'^-\s+', '・', line)
            cleaned.append(line)
        r11_cells[1] = replace_cell_content(
            r11_cells[1], make_paras(cleaned if cleaned else ["—"])
        )
        rows[11] = put_cells(rows[11], r11_cells)

        # ── Row 12: continuation (clear it) ─────────────────────────────
        if len(rows) > 12:
            r12_cells = get_cells(rows[12])
            r12_cells[1] = replace_cell_content(r12_cells[1], make_para(""))
            rows[12] = put_cells(rows[12], r12_cells)

        # ── Row 13: QA | (qa content) ───────────────────────────────────
        if len(rows) > 13:
            r13_cells = get_cells(rows[13])
            if qa:
                qa_lines = []
                for item in qa:
                    qa_lines.append(f"Q: {item.get('q', '?')}")
                    qa_lines.append(f"A: {item.get('a', '—')}")
                    qa_lines.append("")
                qa_lines = [l for l in qa_lines if l != "" or qa_lines.index(l) != len(qa_lines) - 1]
            else:
                qa_lines = ["—"]
            r13_cells[1] = replace_cell_content(
                r13_cells[1], make_paras(qa_lines)
            )
            rows[13] = put_cells(rows[13], r13_cells)

        # ── Reconstruct table XML ────────────────────────────────────────
        new_tbl = put_rows(tbl_xml, rows)
        new_xml = xml.replace(tbl_xml, new_tbl, 1)

        # ── Write modified docx ──────────────────────────────────────────
        with zipfile.ZipFile(output_path, "r") as zin, \
             zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                if item.filename == "word/document.xml":
                    zout.writestr(item, new_xml.encode("utf-8"))
                else:
                    zout.writestr(item, zin.read(item.filename))

        shutil.move(tmp_path, output_path)

    except Exception:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        print("Usage: generate_meeting_note.py <template.docx> <output.docx> [json]",
              file=sys.stderr)
        sys.exit(1)

    template_path = args[0]
    output_path   = args[1]
    json_str      = args[2] if len(args) > 2 else sys.stdin.read()

    if not os.path.exists(template_path):
        print(f"Template not found: {template_path}", file=sys.stderr)
        sys.exit(1)

    try:
        data = json.loads(json_str)
    except json.JSONDecodeError as e:
        print(f"Invalid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    fill_template(template_path, output_path, data)
    print(output_path)


if __name__ == "__main__":
    main()
