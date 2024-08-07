import { DEV } from 'esm-env';
import { clear_text_content, empty, init_operations } from './dom/operations.js';
import { HYDRATION_ERROR, HYDRATION_START, PassiveDelegatedEvents } from '../../constants.js';
import { flush_sync, push, pop, current_component_context } from './runtime.js';
import { effect_root, branch } from './reactivity/effects.js';
import {
	hydrate_anchor,
	hydrate_nodes,
	set_hydrate_nodes,
	set_hydrating
} from './dom/hydration.js';
import { array_from } from './utils.js';
import { handle_event_propagation } from './dom/elements/events.js';
import { reset_head_anchor } from './dom/blocks/svelte-head.js';
import * as w from './warnings.js';
import * as e from './errors.js';
import { validate_component } from '../shared/validate.js';

/** @type {Set<string>} */
export const all_registered_events = new Set();

/** @type {Set<(events: Array<string>) => void>} */
export const root_event_handles = new Set();

/**
 * This is normally true — block effects should run their intro transitions —
 * but is false during hydration and mounting (unless `options.intro` is `true`)
 * and when creating the children of a `<svelte:element>` that just changed tag
 */
export let should_intro = true;

/** @param {boolean} value */
export function set_should_intro(value) {
	should_intro = value;
}

/**
 * @param {Element} text
 * @param {string} value
 * @returns {void}
 */
export function set_text(text, value) {
	// @ts-expect-error
	const prev = (text.__t ??= text.nodeValue);

	if (prev !== value) {
		// @ts-expect-error
		text.nodeValue = text.__t = value;
	}
}

/**
 * @param {Comment} anchor
 * @param {void | ((anchor: Comment, slot_props: Record<string, unknown>) => void)} slot_fn
 * @param {Record<string, unknown>} slot_props
 * @param {null | ((anchor: Comment) => void)} fallback_fn
 */
export function slot(anchor, slot_fn, slot_props, fallback_fn) {
	if (slot_fn === undefined) {
		if (fallback_fn !== null) {
			fallback_fn(anchor);
		}
	} else {
		slot_fn(anchor, slot_props);
	}
}

/**
 * Mounts a component to the given target and returns the exports and potentially the props (if compiled with `accessors: true`) of the component
 *
 * @template {Record<string, any>} Props
 * @template {Record<string, any>} Exports
 * @param {import('../../index.js').ComponentType<import('../../index.js').SvelteComponent<Props>> | import('../../index.js').Component<Props, Exports, any>} component
 * @param {{} extends Props ? {
 * 		target: Document | Element | ShadowRoot;
 * 		anchor?: Node;
 * 		props?: Props;
 * 		events?: Record<string, (e: any) => any>;
 * 		context?: Map<any, any>;
 * 		intro?: boolean;
 * 	}: {
 * 		target: Document | Element | ShadowRoot;
 * 		props: Props;
 * 		anchor?: Node;
 * 		events?: Record<string, (e: any) => any>;
 * 		context?: Map<any, any>;
 * 		intro?: boolean;
 * 	}} options
 * @returns {Exports}
 */
export function mount(component, options) {
	if (DEV) {
		validate_component(component);
	}

	const anchor = options.anchor ?? options.target.appendChild(empty());
	// Don't flush previous effects to ensure order of outer effects stays consistent
	return flush_sync(() => _mount(component, { ...options, anchor }), false);
}

/**
 * Hydrates a component on the given target and returns the exports and potentially the props (if compiled with `accessors: true`) of the component
 *
 * @template {Record<string, any>} Props
 * @template {Record<string, any>} Exports
 * @param {import('../../index.js').ComponentType<import('../../index.js').SvelteComponent<Props>> | import('../../index.js').Component<Props, Exports, any>} component
 * @param {{} extends Props ? {
 * 		target: Document | Element | ShadowRoot;
 * 		props?: Props;
 * 		events?: Record<string, (e: any) => any>;
 *  	context?: Map<any, any>;
 * 		intro?: boolean;
 * 		recover?: boolean;
 * 	} : {
 * 		target: Document | Element | ShadowRoot;
 * 		props: Props;
 * 		events?: Record<string, (e: any) => any>;
 *  	context?: Map<any, any>;
 * 		intro?: boolean;
 * 		recover?: boolean;
 * 	}} options
 * @returns {Exports}
 */
export function hydrate(component, options) {
	if (DEV) {
		validate_component(component);
	}

	const target = options.target;
	const previous_hydrate_nodes = hydrate_nodes;

	try {
		// Don't flush previous effects to ensure order of outer effects stays consistent
		return flush_sync(() => {
			set_hydrating(true);

			var node = target.firstChild;
			while (
				node &&
				(node.nodeType !== 8 || /** @type {Comment} */ (node).data !== HYDRATION_START)
			) {
				node = node.nextSibling;
			}

			if (!node) {
				throw HYDRATION_ERROR;
			}

			const anchor = hydrate_anchor(node);
			const instance = _mount(component, { ...options, anchor });

			// flush_sync will run this callback and then synchronously run any pending effects,
			// which don't belong to the hydration phase anymore - therefore reset it here
			set_hydrating(false);

			return instance;
		}, false);
	} catch (error) {
		if (error === HYDRATION_ERROR) {
			if (options.recover === false) {
				e.hydration_failed();
			}

			// If an error occured above, the operations might not yet have been initialised.
			init_operations();
			clear_text_content(target);

			set_hydrating(false);
			return mount(component, options);
		}

		throw error;
	} finally {
		set_hydrating(!!previous_hydrate_nodes);
		set_hydrate_nodes(previous_hydrate_nodes);
		reset_head_anchor();
	}
}

/**
 * @template {Record<string, any>} Exports
 * @param {import('../../index.js').ComponentType<import('../../index.js').SvelteComponent<any>> | import('../../index.js').Component<any>} Component
 * @param {{
 * 		target: Document | Element | ShadowRoot;
 * 		anchor: Node;
 * 		props?: any;
 * 		events?: any;
 * 		context?: Map<any, any>;
 * 		intro?: boolean;
 * 	}} options
 * @returns {Exports}
 */
function _mount(Component, { target, anchor, props = {}, events, context, intro = false }) {
	init_operations();

	const registered_events = new Set();

	/** @param {Array<string>} events */
	const event_handle = (events) => {
		for (let i = 0; i < events.length; i++) {
			const event_name = events[i];
			const passive = PassiveDelegatedEvents.includes(event_name);

			if (!registered_events.has(event_name)) {
				registered_events.add(event_name);

				// Add the event listener to both the container and the document.
				// The container listener ensures we catch events from within in case
				// the outer content stops propagation of the event.
				target.addEventListener(event_name, handle_event_propagation, { passive });

				// The document listener ensures we catch events that originate from elements that were
				// manually moved outside of the container (e.g. via manual portals).
				document.addEventListener(event_name, handle_event_propagation, { passive });
			}
		}
	};

	event_handle(array_from(all_registered_events));
	root_event_handles.add(event_handle);

	/** @type {Exports} */
	// @ts-expect-error will be defined because the render effect runs synchronously
	let component = undefined;

	const unmount = effect_root(() => {
		branch(() => {
			if (context) {
				push({});
				var ctx = /** @type {import('#client').ComponentContext} */ (current_component_context);
				ctx.c = context;
			}

			if (events) {
				// We can't spread the object or else we'd lose the state proxy stuff, if it is one
				/** @type {any} */ (props).$$events = events;
			}

			should_intro = intro;
			// @ts-expect-error the public typings are not what the actual function looks like
			component = Component(anchor, props) || {};
			should_intro = true;

			if (context) {
				pop();
			}
		});

		return () => {
			for (const event_name of registered_events) {
				target.removeEventListener(event_name, handle_event_propagation);
				document.removeEventListener(event_name, handle_event_propagation);
			}

			root_event_handles.delete(event_handle);
			mounted_components.delete(component);
		};
	});

	mounted_components.set(component, unmount);
	return component;
}

/**
 * References of the components that were mounted or hydrated.
 * Uses a `WeakMap` to avoid memory leaks.
 */
let mounted_components = new WeakMap();

/**
 * Unmounts a component that was previously mounted using `mount` or `hydrate`.
 * @param {Record<string, any>} component
 */
export function unmount(component) {
	const fn = mounted_components.get(component);
	if (DEV && !fn) {
		w.lifecycle_double_unmount();
		// eslint-disable-next-line no-console
		console.trace('stack trace');
	}
	fn?.();
}

/**
 * @param {Record<string, any>} props
 * @returns {Record<string, any>}
 */
export function sanitize_slots(props) {
	const sanitized = { ...props.$$slots };
	if (props.children) sanitized.default = props.children;
	return sanitized;
}

/**
 * @param {Node} target
 * @param {string} style_sheet_id
 * @param {string} styles
 */
export async function append_styles(target, style_sheet_id, styles) {
	// Wait a tick so that the template is added to the dom, else getRootNode() will yield wrong results
	// If it turns out that this results in noticeable flickering, we need to do something like doing the
	// append outside and adding code in mount that appends all stylesheets (similar to how we do it with event delegation)
	await Promise.resolve();
	const append_styles_to = get_root_for_style(target);
	if (!append_styles_to.getElementById(style_sheet_id)) {
		const style = document.createElement('style');
		style.id = style_sheet_id;
		style.textContent = styles;
		const target = /** @type {Document} */ (append_styles_to).head || append_styles_to;
		target.appendChild(style);
	}
}

/**
 * @param {Node} node
 */
function get_root_for_style(node) {
	if (!node) return document;
	const root = node.getRootNode ? node.getRootNode() : node.ownerDocument;
	if (root && /** @type {ShadowRoot} */ (root).host) {
		return /** @type {ShadowRoot} */ (root);
	}
	return /** @type {Document} */ (node.ownerDocument);
}
