declare module "plotly.js-dist-min" {
  const Plotly: {
    newPlot: (
      el: HTMLElement,
      data: unknown[],
      layout?: Record<string, unknown>,
      config?: Record<string, unknown>
    ) => Promise<void>;
    react: (
      el: HTMLElement,
      data: unknown[],
      layout?: Record<string, unknown>,
      config?: Record<string, unknown>
    ) => Promise<void>;
    purge: (el: HTMLElement) => void;
    Plots: {
      resize: (el: HTMLElement) => void;
    };
    /**
     * Accepts either a mounted graph div or a plain figure object; the
     * latter is rendered into a hidden, temporary div internally. Resolves
     * to a `data:image/<format>;base64,...` URL.
     */
    toImage: (
      figure: HTMLElement | { data: unknown[]; layout?: Record<string, unknown> },
      opts: { format: "png" | "jpeg" | "webp" | "svg"; width?: number; height?: number }
    ) => Promise<string>;
  };
  export default Plotly;
}
