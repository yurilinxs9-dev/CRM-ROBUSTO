'use client';

import { useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export const PRESET_COLORS = [
  '#3498DB',
  '#2ECC71',
  '#F1C40F',
  '#E67E22',
  '#E74C3C',
  '#9B59B6',
  '#1ABC9C',
  '#34495E',
  '#FF6B9D',
  '#95A5A6',
  '#16A085',
  '#27AE60',
];

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  children: React.ReactNode;
}

export function ColorPicker({ value, onChange, children }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState(value);

  const commit = (color: string) => {
    if (HEX_RE.test(color)) {
      onChange(color);
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="start">
        <div className="grid grid-cols-6 gap-2">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Cor ${c}`}
              onClick={() => {
                setHex(c);
                commit(c);
              }}
              className="h-7 w-7 rounded-md border border-border ring-offset-background transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Input
            value={hex}
            onChange={(e) => setHex(e.target.value)}
            placeholder="#3498DB"
            className="h-8 text-xs font-mono"
            maxLength={7}
          />
          <Button
            type="button"
            size="sm"
            className="h-8"
            onClick={() => commit(hex)}
            disabled={!HEX_RE.test(hex)}
          >
            OK
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
