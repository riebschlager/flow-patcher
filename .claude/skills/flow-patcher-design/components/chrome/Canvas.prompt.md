The patch canvas: 20px grid, a cable layer, and absolutely positioned nodes as children.

```jsx
<Canvas height={400} cables={[{ type: 'audio', from: [208, 88], to: [256, 88] }]}>
  <div style={{ position: 'absolute', left: 24, top: 40 }}><Node title="Pointer" /></div>
</Canvas>
```
