import { parseHTML } from "linkedom";

function resolveWebUrl(value: string, base: string): URL | undefined {
	try {
		return new URL(value, base);
	} catch (error) {
		if (error instanceof TypeError) return undefined;
		throw error;
	}
}

/** Parse inert HTML without installing globals, running scripts, or loading resources. */
export function parseWebDocument(html: string, url: string): Document {
	const source = /<html(?:\s|>)/i.test(html) ? html : `<html><head></head><body>${html}</body></html>`;
	const { document } = parseHTML(source);
	return applyWebDocumentUrl(document, url);
}

/** Cloned documents do not retain own URL properties; callers must reapply them. */
export function applyWebDocumentUrl(document: Document, url: string): Document {
	const href = document.querySelector("base[href]")?.getAttribute("href");
	const baseURI = href === null || href === undefined ? url : (resolveWebUrl(href, url)?.href ?? url);
	Object.defineProperties(document, {
		URL: { configurable: true, value: url },
		documentURI: { configurable: true, value: url },
		baseURI: { configurable: true, value: baseURI },
	});
	return document;
}

/** Normalize only the URL-bearing attributes consumed by markdown conversion. */
export function normalizeWebUrls(root: HTMLElement, document: Document): void {
	for (const element of root.querySelectorAll("a[href], img[src]")) {
		const attribute = element.localName === "a" ? "href" : "src";
		const value = element.getAttribute(attribute) ?? "";
		const destination = resolveWebUrl(value, document.baseURI);
		if (element.localName === "a" && destination?.protocol === "javascript:") {
			element.replaceWith(...element.childNodes);
			continue;
		}
		if (value.startsWith("#") && document.baseURI === document.URL) continue;
		if (destination) element.setAttribute(attribute, destination.href);
	}
}
