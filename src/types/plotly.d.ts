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
  };
  export default Plotly;
}
