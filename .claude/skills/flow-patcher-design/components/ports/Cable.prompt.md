An SVG <g> cable between two ports; render inside an <svg> under nodes (Canvas does this for you).

```jsx
<svg width="300" height="60"><Cable type="note" from={[0,20]} to={[300,40]} firing /></svg>
```

Event short dash, Note long dash, Signal hairline, Audio 3px, Field double rail, Value dotted. Also exports cablePath(x1,y1,x2,y2,curve) and CABLE_STYLES.
