import { useEffect, useState, type ComponentProps } from 'react';
import {
  defaultComponents,
  defaultRemarkPlugins,
  Streamdown,
  type Components,
  type ExtraProps
} from 'streamdown';
import { useDispatch, useSelector } from '@/webview/views/StoreContext';

export const copyFeedbackDuration = 2000;
const DefaultLink = defaultComponents.a;

// Its modal opens links with `window.open`, which a webview ignores; a plain link's click goes to VS Code, which opens it.
const linkSafety = { enabled: false };
const components: Components = { a: Link, img: MarkdownImage };
const remarkPlugins = [...Object.values(defaultRemarkPlugins), imageReferences];
// A transport through Markdown's URL sanitization, never a browser image source.
const imageSourcePrefix = 'https://markdown-image.invalid/';

interface MarkdownNode {
  type: string;
  alt?: string | null;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
}

function imageReferences() {
  return function replaceImages(node: MarkdownNode): void {
    const definitions = new Map<string, string>();
    const collect = (current: MarkdownNode): void => {
      if (current.type === 'definition' && current.identifier && current.url) { definitions.set(current.identifier.toLowerCase(), current.url); }
      current.children?.forEach(collect);
    };
    collect(node);
    replace(node);
    function replace(node: MarkdownNode): void {
      if (!node.children) { return; }
      node.children = node.children.map((child) => {
        if (child.type === 'image' || child.type === 'imageReference') {
          const source = child.url ?? definitions.get(child.identifier?.toLowerCase() ?? '');
          if (source && !/^http:|^(?!data:|https:|file:)[a-z][a-z\d+.-]*:/i.test(source)) {
            return { ...child, type: 'image', url: `${imageSourcePrefix}${encodeURIComponent(source)}` };
          }
          const explanation = source && /^http:/i.test(source) ? ': HTTP images are blocked; HTTPS is required' : ': unsupported image source';
          return { type: 'text', value: `${child.alt ? `${child.alt} — image not displayed` : 'Image not displayed'}${explanation}` };
        }
        replace(child);
        return child;
      });
    }
  };
}

/** An agent message's markdown, rendered again as it streams. */
export function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Streamdown isAnimating={streaming} linkSafety={linkSafety} components={components} remarkPlugins={remarkPlugins}>
      {text}
    </Streamdown>
  );
}

let nextOccurrence = 1;

function MarkdownImage({ alt, src }: ComponentProps<'img'> & ExtraProps) {
  let source: string | null = null;
  if (typeof src === 'string' && src.startsWith(imageSourcePrefix)) {
    try {
      const decoded = decodeURIComponent(src.slice(imageSourcePrefix.length));
      source = decoded;
    } catch { /* An agent can supply malformed URLs in raw HTML. */ }
  }
  return source ? <ValidatedImage source={source} alt={alt ?? ''} />
    : <span>{alt ? `${alt} — image not displayed` : 'Image not displayed'}</span>;
}

function ValidatedImage({ source, alt }: { source: string; alt: string }) {
  const dispatch = useDispatch();
  const [image, setImage] = useState(() => ({ source, occurrence: nextOccurrence++, failed: false }));
  if (image.source !== source) { setImage({ source, occurrence: nextOccurrence++, failed: false }); }
  const { occurrence, failed } = image;
  const presentation = useSelector((state) => state.transcript.markdownImages.get(occurrence)?.presentation);
  const origin = useSelector((state) => state.transcript.markdownOrigin);
  useEffect(() => {
    dispatch({ type: 'markdownImageMounted', occurrence, source });
    return () => dispatch({ type: 'markdownImageUnmounted', occurrence });
  }, [dispatch, occurrence, source]);
  return presentation?.src && !failed
    ? <img src={presentation.src} alt={alt} className="h-auto w-auto max-h-96 max-w-full object-contain" onError={() => setImage({ ...image, failed: true })} />
    : <span>
      <span role="img" aria-label={alt || 'Image from agent'}>{alt ? `${alt} — ` : ''}{presentation?.status === 'loading' ? 'Loading image' : 'Image not displayed'}{failed
        ? ': browser could not render it' : presentation?.fallback ? `: ${presentation.fallback}` : ''}</span>
      {presentation?.status === 'consent' && <span className="block break-all text-sm">
        <strong>{new URL(source).hostname}</strong> — {source}<br />
        Loading contacts an external server from the {origin ?? 'extension host (location unknown)'}. The destination may redirect.
      </span>}
      {(presentation?.status === 'consent' || presentation?.status === 'retry') && <button type="button" className="text-link" onClick={() => dispatch({ type: 'markdownImageLoad', occurrence })}>
        {presentation.status === 'consent' ? 'Load image' : 'Retry'}
      </button>}
    </span>;
}

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
    const timer = setTimeout(() => setCopied(false), copyFeedbackDuration);
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
