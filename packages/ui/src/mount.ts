import type { PageContext, ViewHandle, ViewModule } from '@qaily/contracts';

/** A Lit view element: receives the model and context as properties. */
export interface ModelElement<M> extends HTMLElement {
  model: M;
  ctx: PageContext;
}

/** Builds a ViewModule that renders a custom element, so most views are one line. */
export function elementView<M>(tag: string, ctor: CustomElementConstructor): ViewModule<M> {
  if (!customElements.get(tag)) customElements.define(tag, ctor);
  return {
    mount(host, model, ctx): ViewHandle<M> {
      const el = document.createElement(tag) as ModelElement<M>;
      el.model = model;
      el.ctx = ctx;
      host.append(el);
      return {
        update(next, nextCtx) {
          el.ctx = nextCtx;
          el.model = next;
        },
        destroy() {
          el.remove();
        },
      };
    },
  };
}
