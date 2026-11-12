// no5tyle's shared app switcher, a custom element from https://no5tyle.github.io/shared/app-switcher.js
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "n5-app-switcher": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { current?: string };
    }
  }
}
