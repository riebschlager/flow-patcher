The rotary control for the inspector and Play strip. Drag vertically, Shift for fine, double-click or right-click to reset.

```jsx
<Knob label="Cutoff" defaultValue={0.62} format={v => Math.round(20*Math.pow(1000,v))+' Hz'} />
<Knob label="Depth" mod={0.2} />
```

size 48 in inspector, 44 in the Play strip.
