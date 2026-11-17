// qstored's app switcher, a custom element from public/qstored-switcher.js
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "qs-app-switcher": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { current?: string };
    }
  }
}
