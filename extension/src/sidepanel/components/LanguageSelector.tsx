import React from 'react';
import { LANGUAGES } from '../hooks/useTranscript';

interface Props {
  primaryLang: string;
  secondaryLang: string;
  bilingual: boolean;
  onChangePrimary: (lang: string) => void;
  onChangeSecondary: (lang: string) => void;
  onToggleBilingual: (enabled: boolean) => void;
}

export default function LanguageSelector({
  primaryLang,
  secondaryLang,
  bilingual,
  onChangePrimary,
  onChangeSecondary,
  onToggleBilingual,
}: Props) {
  return (
    <div className="language-selector">
      <div className="lang-row">
        <select
          value={primaryLang}
          onChange={(e) => onChangePrimary(e.target.value)}
          className="language-select"
          aria-label="Primary transcription language"
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.label}
            </option>
          ))}
        </select>
        {bilingual && (
          <>
            <span className="lang-plus" aria-hidden="true">
              +
            </span>
            <select
              value={secondaryLang}
              onChange={(e) => onChangeSecondary(e.target.value)}
              className="language-select"
              aria-label="Secondary transcription language"
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      <label className="bilingual-toggle">
        <input
          type="checkbox"
          checked={bilingual}
          onChange={(e) => onToggleBilingual(e.target.checked)}
          aria-label="Enable bilingual mode"
        />
        <span className="bilingual-label">Bilingual</span>
      </label>
    </div>
  );
}
