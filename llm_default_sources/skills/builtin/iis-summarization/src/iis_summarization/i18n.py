"""
i18n.py
───────
Output-language resolution and the message catalog for the
deterministic (Python-written) parts of the infeasibility report.

The skill produces output from four sources — the report template, this
module's catalog (report headers + the value-trace / caveat prose), the
value-propagation connectors in :mod:`propagation`, and the LLM
subagents. Everything Python writes is localized through here so the
report is language-consistent with the runtime environment.

Language is resolved once on the CLI and threaded down through
:class:`~iis_summarization.analyzer.AnalysisOptions`:

* an explicit ``--lang ja|en`` always wins;
* ``--lang auto`` (the default) detects the OS locale from the POSIX
  locale env vars (``LC_ALL`` ▸ ``LC_MESSAGES`` ▸ ``LANG`` ▸
  ``LANGUAGE``) and selects Japanese when the active locale names it;
* anything unrecognised falls back to English.

Only two languages are supported (``"en"`` / ``"ja"``); the catalog
keeps both side by side so a missing translation degrades to English
rather than raising.
"""

from __future__ import annotations

import os
from typing import Final

# Supported output languages. English is the canonical fallback.
SUPPORTED_LANGUAGES: Final[tuple[str, ...]] = ("en", "ja")
DEFAULT_LANGUAGE: Final[str] = "en"

# POSIX locale env vars in precedence order. LC_ALL overrides everything;
# LANGUAGE is a colon-separated priority list (e.g. "ja_JP:en_US").
_LOCALE_ENV_VARS: Final[tuple[str, ...]] = ("LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE")


def resolve_language(explicit: str | None = None) -> str:
    """Resolve the output language: explicit flag ▸ OS locale ▸ English.

    *explicit* is the ``--lang`` value. ``"ja"``/``"en"`` (or a locale
    string like ``"ja_JP.UTF-8"``) force that language; ``None`` or
    ``"auto"`` triggers OS-locale detection. Detection reads the POSIX
    locale env vars and returns ``"ja"`` when the active locale names
    Japanese, otherwise ``"en"``.
    """
    if explicit is not None and explicit.strip().lower() not in ("", "auto"):
        return _normalize(explicit)

    for var in _LOCALE_ENV_VARS:
        value = os.environ.get(var)
        if value and value.strip().lower().startswith("ja"):
            return "ja"
    return DEFAULT_LANGUAGE


def _normalize(value: str) -> str:
    """Map a raw language/locale string to a supported code."""
    normalized = value.strip().lower()
    if normalized in SUPPORTED_LANGUAGES:
        return normalized
    if normalized.startswith("ja"):
        return "ja"
    return DEFAULT_LANGUAGE


# ─────────────────────────────────────────────────────────────
# Message catalog
# ─────────────────────────────────────────────────────────────
#
# Every entry carries both languages. ``{name}`` placeholders are filled
# by :func:`tr` via ``str.format``; variable names, constraint names, and
# numeric values are passed through verbatim (they are language-neutral).

_CATALOG: Final[dict[str, dict[str, str]]] = {
    # ── report template ──
    "report_title": {
        "en": "Infeasibility Report",
        "ja": "実行不可能性レポート",
    },
    "generated_label": {
        "en": "Generated",
        "ja": "生成日時",
    },
    # ── value-trace section (report_generator) ──
    "value_trace_header": {
        "en": "Why infeasible — value trace",
        "ja": "実行不可能な理由 — 値のトレース",
    },
    "value_trace_intro": {
        "en": "Following the forced implications through the conflicting constraints:",
        "ja": "矛盾する制約を通じて強制される含意を順にたどると：",
    },
    "value_trace_combinatorial": {
        "en": (
            "Bound propagation did not isolate a single empty domain — the "
            "conflict is combinatorial across the constraints, not reducible "
            "to one forced value. See the `.ilp` file for the full constraint set."
        ),
        "ja": (
            "境界伝播では単一の空領域を特定できませんでした — 矛盾は複数の制約に"
            "またがる組合せ的なもので、単一の強制値には還元できません。制約の全体は "
            "`.ilp` ファイルを参照してください。"
        ),
    },
    "value_trace_omitted": {
        "en": "_… {n} earlier tightening step(s) omitted._",
        "ja": "_… それ以前の絞り込みステップ {n} 件を省略。_",
    },
    "contradiction_label": {
        "en": "Contradiction",
        "ja": "矛盾",
    },
    # ── unsupported-element caveat (report_generator) ──
    "caveat_header": {
        "en": "Caveat — elements outside the linear analysis",
        "ja": "注意 — 線形分析の対象外の要素",
    },
    "caveat_body": {
        "en": (
            "This IIS also contains {summary}. The DATA/STRUCTURE classifier, "
            "the value trace, and the relaxation amounts reason over the linear "
            "constraints only, so these elements are **not** reflected in the "
            "diagnosis above. If the root cause is not convincing, the conflict "
            "may be driven by one of them — inspect the `.ilp` directly."
        ),
        "ja": (
            "この IIS には {summary} も含まれています。DATA/STRUCTURE 分類、値の"
            "トレース、緩和量はいずれも線形制約のみを対象とするため、これらの要素は"
            "上記の診断に**反映されていません**。根本原因に納得できない場合は、これ"
            "らのいずれかが矛盾を引き起こしている可能性があります — `.ilp` を直接"
            "確認してください。"
        ),
    },
    # ── propagation step / contradiction connectors ──
    "forced_le": {
        "en": "`{var}` is forced to ≤ {ub} by `{cons}`, but its lower bound is {lb}",
        "ja": "`{var}` は `{cons}` により ≤ {ub} に強制されますが、その下限は {lb} です",
    },
    "forced_ge": {
        "en": "`{var}` is forced to ≥ {lb} by `{cons}`, but its upper bound is {ub}",
        "ja": "`{var}` は `{cons}` により ≥ {lb} に強制されますが、その上限は {ub} です",
    },
    "default_lb_note": {
        "en": " (Gurobi default lower bound 0)",
        "ja": "（Gurobi のデフォルト下限 0）",
    },
    "no_feasible": {
        "en": " — no feasible value exists.",
        "ja": " — 実行可能な値が存在しません。",
    },
    "step_fixed": {
        "en": "{var} fixed to {val}",
        "ja": "{var} を {val} に固定",
    },
    # ── enumeration summary (enumeration.py) ──
    "enum_title": {
        "en": "IIS Enumeration Report",
        "ja": "IIS 列挙レポート",
    },
    "enum_model": {
        "en": "Model",
        "ja": "モデル",
    },
    "enum_found": {
        "en": "IISes found",
        "ja": "発見された IIS",
    },
    "enum_terminated": {
        "en": "Terminated",
        "ja": "終了理由",
    },
    "enum_elapsed": {
        "en": "Elapsed",
        "ja": "経過時間",
    },
    "enum_feasible": {
        "en": (
            "Model is feasible — no IIS exists. (If you expected an "
            "infeasibility, double-check you're pointing at the right `.lp`.)"
        ),
        "ja": (
            "モデルは実行可能です — IIS は存在しません。（実行不可能を想定していた"
            "場合は、正しい `.lp` を指しているか再確認してください。）"
        ),
    },
    "enum_failed": {
        "en": "Enumeration failed: {error}",
        "ja": "列挙に失敗しました: {error}",
    },
    "enum_none": {
        "en": "No IIS was produced before the enumeration stopped.",
        "ja": "列挙が停止するまでに IIS は生成されませんでした。",
    },
    "enum_per_iis": {
        "en": "Per-IIS detail",
        "ja": "IIS ごとの詳細",
    },
    "enum_table_header": {
        "en": "| # | Size | Families | Elapsed | File |",
        "ja": "| # | サイズ | ファミリ | 経過時間 | ファイル |",
    },
    "enum_more": {
        "en": "+{n} more",
        "ja": "他 {n} 件",
    },
    "enum_cross_title": {
        "en": "Cross-IIS template summary",
        "ja": "IIS 横断テンプレート集計",
    },
    "enum_cross_intro": {
        "en": (
            "How often each constraint-name template appeared across the "
            "enumerated IISes. Templates that repeat in many IISes are "
            "almost certainly the same modelling rule misfiring at multiple "
            "indices — fix the rule once, all instances disappear."
        ),
        "ja": (
            "各制約名テンプレートが列挙された IIS にわたって出現した回数です。"
            "多くの IIS で繰り返されるテンプレートは、ほぼ確実に同一のモデリング"
            "ルールが複数のインデックスで誤作動しています — ルールを一度修正すれば、"
            "すべてのインスタンスが解消します。"
        ),
    },
    "enum_cross_header": {
        "en": "| Template | IISes containing it | Indices |",
        "ja": "| テンプレート | 含まれる IIS 数 | インデックス |",
    },
    "enum_footer": {
        "en": "Each IIS's full constraint list is in the matching `.ilp` file.",
        "ja": "各 IIS の完全な制約リストは対応する `.ilp` ファイルにあります。",
    },
    # Termination-reason labels (machine codes → human text). Dynamic
    # codes like ``status_<n>`` have no entry and fall back to the raw code.
    "enum_reason_feasible": {"en": "feasible", "ja": "実行可能に到達"},
    "enum_reason_budget": {"en": "budget exhausted", "ja": "時間予算を使い切り"},
    "enum_reason_unbounded": {"en": "model became unbounded", "ja": "モデルが非有界化"},
    "enum_reason_timeout": {"en": "feasibility-solve timeout", "ja": "実行可能性判定がタイムアウト"},
    "enum_reason_iis_timeout": {"en": "computeIIS timeout", "ja": "IIS 計算がタイムアウト"},
    "enum_reason_max_iises": {"en": "reached --max-iises cap", "ja": "--max-iises 上限に到達"},
    "enum_reason_error": {"en": "error", "ja": "エラー"},
    "enum_reason_gurobi_unavailable": {"en": "Gurobi unavailable", "ja": "Gurobi を利用できません"},
    # ── template chrome ──
    "tech_details_summary": {
        "en": "Technical details (diagnostic findings &amp; constraint bodies — click to expand)",
        "ja": "技術詳細（診断結果と制約の内容 — クリックで展開）",
    },
    "report_footer": {
        "en": "Generated by the `iis_summarization` skill.",
        "ja": "`iis_summarization` スキルにより生成。",
    },
    "diagnostics_header": {
        "en": "Diagnostic findings",
        "ja": "診断結果",
    },
    # ── remediation plan (Step 7) ──
    "remediation_header": {
        "en": "Remediation plan (minimum data changes)",
        "ja": "修正プラン（最小のデータ変更）",
    },
    "remediation_table_header": {
        "en": "| Constraint | Sense | Current RHS | Suggested RHS | Change |",
        "ja": "| 制約 | 符号 | 現在の RHS | 推奨 RHS | 変更 |",
    },
    "bound_relax_table_header": {
        "en": "| Variable | Current bounds | Needed loosening |",
        "ja": "| 変数 | 現在の境界 | 必要な緩和 |",
    },
    "total_violation_line": {
        "en": "Total L1 violation: **{v}**.",
        "ja": "L1 違反量の合計: **{v}**。",
    },
    "fix_verified_line": {
        "en": (
            "**Fix verified:** applying the suggested changes to a copy of "
            "the model restored feasibility (verified by re-solving)."
        ),
        "ja": (
            "**修正を検証済み:** 推奨された変更をモデルのコピーに適用して再求解"
            "した結果、実行可能性が回復しました（再求解により検証済み）。"
        ),
    },
    "fix_not_verified_line": {
        "en": (
            "**Fix NOT verified:** {msg} Treat the table above as a "
            "starting point, not a complete remedy."
        ),
        "ja": (
            "**修正は未検証です:** {msg} 上の表は完全な解決策ではなく、出発点"
            "として扱ってください。"
        ),
    },
    "lb_down_by": {"en": "LB down by {v}", "ja": "下限を {v} 下げる"},
    "ub_up_by": {"en": "UB up by {v}", "ja": "上限を {v} 上げる"},
    "widens_range_note": {
        "en": (
            "— this WIDENS ranged constraint `{name}` (internal range "
            "slack), it does not move a real variable's bound"
        ),
        "ja": (
            "— これはレンジ制約 `{name}` の幅を広げます（内部レンジスラック）。"
            "実際の変数の境界は変わりません"
        ),
    },
    # ── indicator remediation (Step 7b) ──
    "indicator_header": {
        "en": "Indicator-constraint remediation (alternative fix)",
        "ja": "インジケータ制約の修正（代替案）",
    },
    "indicator_intro": {
        "en": (
            "feasRelax cannot relax indicator constraints; these deltas were "
            "computed by injecting a minimized explicit slack into each "
            "indicator's linear part (Gurobi-recommended pattern). Apply "
            "EITHER these changes OR the linear plan — they are alternatives, "
            "not additive."
        ),
        "ja": (
            "feasRelax はインジケータ制約を緩和できないため、各インジケータの"
            "線形部分に最小化スラックを挿入して差分を計算しました（Gurobi 推奨"
            "パターン）。この変更**または**線形の修正プランの**どちらか一方**を"
            "適用してください — 両方は不要です。"
        ),
    },
    "indicator_table_header": {
        "en": "| Indicator | Sense | Current RHS | Suggested RHS | Change |",
        "ja": "| インジケータ | 符号 | 現在の RHS | 推奨 RHS | 変更 |",
    },
    # ── numerics screen ──
    "numerics_header": {
        "en": "Numerical health",
        "ja": "数値的健全性",
    },
    # ── non-linear coverage ──
    "nonlinear_header": {
        "en": "Non-linear constraints in the conflict",
        "ja": "矛盾に含まれる非線形制約",
    },
    "nonlinear_note": {
        "en": (
            "Note: feasRelax can relax **only linear constraints and variable "
            "bounds** (documented Gurobi limitation), so the linear "
            "Remediation plan covers just the linear side of this conflict."
        ),
        "ja": (
            "注意: feasRelax が緩和できるのは**線形制約と変数境界のみ**です"
            "（Gurobi の仕様）。線形の修正プランはこの矛盾の線形部分のみを"
            "対象としています。"
        ),
    },
    "remedy_indicator": {
        "en": (
            "numeric remediation via slack injection — see the "
            "Indicator-constraint remediation table"
        ),
        "ja": (
            "スラック挿入による数値的修正が可能 — インジケータ制約の修正表を"
            "参照してください"
        ),
    },
    "remedy_quadratic": {
        "en": (
            "slack injection applies to CONVEX quadratic constraints "
            "(q(x) − s ≤ rhs, minimize s); for non-convex ones the slack "
            "can alter the structure — review manually"
        ),
        "ja": (
            "凸二次制約にはスラック挿入が適用できます（q(x) − s ≤ rhs、s を"
            "最小化）。非凸の場合はスラックが構造を変える可能性があるため、"
            "手動で確認してください"
        ),
    },
    "remedy_SOS": {
        "en": (
            "no numeric relaxation exists — SOS conflicts are purely "
            "combinatorial; drop the SOS set, reduce its member count, "
            "or reformulate as big-M binaries"
        ),
        "ja": (
            "数値的な緩和は存在しません — SOS の矛盾は純粋に組合せ的です。"
            "SOS 集合の削除、要素数の削減、または big-M バイナリへの再定式化を"
            "検討してください"
        ),
    },
    "remedy_general": {
        "en": (
            "non-indicator general constraint (MIN/MAX/ABS/function) — "
            "per Gurobi, IIS membership for function-approximation "
            "constraints can be UNRELIABLE; treat as low confidence and "
            "review the constraint manually"
        ),
        "ja": (
            "インジケータ以外の一般制約（MIN/MAX/ABS/関数）— Gurobi の仕様上、"
            "関数近似制約の IIS 帰属は**信頼できない場合があります**。低信頼度と"
            "して扱い、手動で確認してください"
        ),
    },
    "remedy_fallback": {"en": "review manually", "ja": "手動で確認してください"},
    # ── default-LB warning / IIS bounds ──
    "default_lb_header": {
        "en": "**Warning: Default Lower Bound = 0**",
        "ja": "**警告: デフォルト下限 = 0**",
    },
    "iis_bounds_header": {
        "en": "**IIS Variable Bounds:**",
        "ja": "**IIS に含まれる変数境界:**",
    },
    "iis_bounds_table_header": {
        "en": "| Variable | Bound Type | Value |",
        "ja": "| 変数 | 境界の種類 | 値 |",
    },
    "lower_bound_label": {"en": "Lower bound (LB)", "ja": "下限 (LB)"},
    "upper_bound_label": {"en": "Upper bound (UB)", "ja": "上限 (UB)"},
    "range_slack_label": {
        "en": "`{var}` — internal slack of ranged constraint `{name}`",
        "ja": "`{var}` — レンジ制約 `{name}` の内部スラック",
    },
    "range_slack_note": {
        "en": (
            "Note: `Rg…` variables are Gurobi-internal slacks that encode a "
            "ranged constraint's width `U − L`; the conflict is in the "
            "ranged constraint itself, not in a variable you declared."
        ),
        "ja": (
            "注意: `Rg…` 変数はレンジ制約の幅 `U − L` を表す Gurobi 内部の"
            "スラックです。矛盾の原因はレンジ制約そのものであり、ユーザーが"
            "宣言した変数ではありません。"
        ),
    },
}


def enum_reason_label(language: str, reason: str) -> str:
    """Localize a termination-reason code, falling back to the raw code.

    Dynamic codes (e.g. ``status_3``) have no catalog entry; they are
    returned verbatim so no information is lost.
    """
    key = f"enum_reason_{reason}"
    if key in _CATALOG:
        return tr(language, key)
    return reason


def tr(language: str, key: str, **kwargs: object) -> str:
    """Return the catalog string for *key* in *language*, formatted.

    Falls back to English for an unsupported language or a missing
    translation. ``{name}`` placeholders are substituted from *kwargs*.
    """
    lang = language if language in SUPPORTED_LANGUAGES else DEFAULT_LANGUAGE
    entry = _CATALOG[key]
    template = entry.get(lang) or entry[DEFAULT_LANGUAGE]
    return template.format(**kwargs) if kwargs else template
