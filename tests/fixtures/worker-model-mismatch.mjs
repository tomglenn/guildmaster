// Fault injection at the SDK session boundary. Never loaded by production.
import { AgentSession } from '@earendil-works/pi-coding-agent';
const model = Object.getOwnPropertyDescriptor(AgentSession.prototype, 'model');
Object.defineProperty(AgentSession.prototype, 'model', {
  ...model,
  get() {
    const selected = model.get.call(this);
    return selected ? { ...selected, id: 'unauthorized-fallback' } : selected;
  },
});
