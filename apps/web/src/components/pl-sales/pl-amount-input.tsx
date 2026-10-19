'use client';
import { useLayoutEffect, useRef } from 'react';
import { brl, parsePartnerAmount } from '@/lib/partners';
import { formatPlAmountInput, plAmountCaret } from '@/lib/pl-amount-input';
import { fieldClass } from '@/components/partners/partner-forms';

export function PlAmountInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const selection = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (selection.current !== null) {
      input.current?.setSelectionRange(selection.current, selection.current);
      selection.current = null;
    }
  }, [value]);

  return <input ref={input} required inputMode="decimal" className={fieldClass} value={value} placeholder="Ex.: R$ 250.000,00"
    onChange={event => {
      event.target.setCustomValidity('');
      const formatted = formatPlAmountInput(event.target.value);
      if (formatted === null) return;
      const caret = plAmountCaret(event.target.value, event.target.selectionStart ?? event.target.value.length, formatted);
      if (formatted === value) event.target.setSelectionRange(caret, caret);
      else { selection.current = caret; onChange(formatted); }
    }}
    onBlur={() => onChange(formatPlAmountInput(value, true) ?? value)}
    onPaste={event => {
      event.preventDefault();
      try {
        const formatted = brl(parsePartnerAmount(event.clipboardData.getData('text')));
        event.currentTarget.setCustomValidity('');
        selection.current = formatted.length;
        onChange(formatted);
      } catch {
        event.currentTarget.setCustomValidity('Cole um valor em reais, como 250.000,00.');
        event.currentTarget.reportValidity();
      }
    }} />;
}
