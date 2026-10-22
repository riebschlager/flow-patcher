// The fluid's Worker (ADR 0016): steps the CPU solver and colorizes off the
// main thread, then hands the pixels back transferred. LivePatch wires it to
// a FluidHost; the protocol is the engine's (fluid/backend.ts).
import { createFluidStepper, fluidReplyTransfer, type FluidStepReply, type FluidStepRequest } from '@flow-patcher/engine';

// The editor compiles against the DOM lib, so the worker scope is typed by hand.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<FluidStepRequest>) => void) | null;
  postMessage(reply: FluidStepReply, transfer: Transferable[]): void;
};

const step = createFluidStepper(() => performance.now());

scope.onmessage = (event) => {
  const reply = step(event.data);
  scope.postMessage(reply, fluidReplyTransfer(reply));
};
