import * as React from 'react';

/** Node-family filter chip with its glyph. Families are identified by glyph, never by color. */
export interface FamilyChipProps {
  family?: 'sources' | 'gestures' | 'time' | 'harmony' | 'control' | 'instruments' | 'effects' | 'visual' | 'output' | 'subpatch';
  count?: number;
  active?: boolean;
  onClick?: () => void;
}

export declare function FamilyChip(props: FamilyChipProps): React.JSX.Element;
