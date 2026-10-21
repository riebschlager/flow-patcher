A patch node: neutral body, family glyph in the header, typed ports on the edges, params below.

```jsx
<Node title="Euclidean" icon="timer" led="event"
  rows={[{ in: { type: 'event', label: 'Clock' }, out: { type: 'event', label: 'Hits' } }]}
  params={[{ label: 'Hits', value: 5/16, display: '5' }]} />
```

Cable geometry: portY(top,row) = top+48+22·row; paramY(top,rows,j) = top+54+22·rows+26·j. Inputs at x, outputs at x+width. Avoid divider rows in nodes you wire with these helpers.
