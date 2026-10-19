import { useEffect, useState, type ComponentProps } from 'react';
import { defaultComponents, Streamdown, type Components, type ExtraProps } from 'streamdown';

// Its modal opens links with `window.open`, which a webview ignores; a plain link's click goes to VS Code, which opens it.
const linkSafety = { enabled: false };
const components: Components = { a: Link };

/** An agent message's markdown, rendered again as it streams. */
export function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Streamdown isAnimating={streaming} linkSafety={linkSafety} components={components}>
      {text}
    </Streamdown>
  );
}

const DefaultLink = defaultComponents.a;
const copiedFor = 2000;

function Link(props: ComponentProps<'a'> & ExtraProps) {
  const { href, className } = props;
  return (
    <>
      <DefaultLink {...props} className={`text-link ${className ?? ''}`} />
      {href !== undefined && copyable(href) && <CopyLinkButton href={href} />}
    </>
  );
}

/** A web or mail link; not one still being written, which `streamdown` gives a placeholder URL. */
function copyable(href: string): boolean {
  return URL.canParse(href) && ['http:', 'https:', 'mailto:'].includes(new URL(href).protocol);
}

function CopyLinkButton({ href }: { href: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), copiedFor);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      aria-label="Copy link"
      title="Copy link"
      className="ml-0.5 inline-flex cursor-pointer align-middle text-muted-foreground hover:text-foreground"
      onClick={() => void navigator.clipboard.writeText(href).then(() => setCopied(true))}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {copied ? (
          <path d="M20 6 9 17l-5-5" />
        ) : (
          <>
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </>
        )}
      </svg>
    </button>
  );
}
