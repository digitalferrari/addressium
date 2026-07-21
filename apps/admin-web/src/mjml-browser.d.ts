declare module "mjml-browser" {
  export interface MjmlError {
    line?: number;
    message: string;
    tagName?: string;
    formattedMessage?: string;
  }
  export interface MjmlResult {
    html: string;
    errors: MjmlError[];
  }
  export default function mjml2html(mjml: string, options?: Record<string, unknown>): MjmlResult;
}
