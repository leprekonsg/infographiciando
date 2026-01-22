import { SlideNode } from "../../types/slideTypes";

// --- DETERMINISTIC AUTO-REPAIR ---

// Component type mapping for unsupported -> supported types
// Includes hyphen, underscore, camelCase, and abbreviated variants
const COMPONENT_TYPE_MAP: Record<string, string> = {
    // Text-based components -> text-bullets
    'text-block': 'text-bullets',
    'text_block': 'text-bullets',
    'textblock': 'text-bullets',
    'text': 'text-bullets',
    'paragraph': 'text-bullets',
    'bullet-list': 'text-bullets',
    'bullet_list': 'text-bullets',
    'bulletlist': 'text-bullets',
    'bullets': 'text-bullets',
    'list': 'text-bullets',
    'content': 'text-bullets',
    'body': 'text-bullets',
    'key-points': 'text-bullets',
    'key_points': 'text-bullets',
    'keypoints': 'text-bullets',
    'visual_list': 'text-bullets', // Also could be icon-grid, defaulting to text
    'visual-list': 'text-bullets',
    'visuallist': 'text-bullets',

    // Metric components -> metric-cards
    'metrics': 'metric-cards',
    'stats': 'metric-cards',
    'kpis': 'metric-cards',
    'cards': 'metric-cards',
    'metric-group': 'metric-cards',
    'metric_group': 'metric-cards',
    'metricgroup': 'metric-cards',
    'stat-cards': 'metric-cards',
    'stat_cards': 'metric-cards',
    'statcards': 'metric-cards',
    'kpi-cards': 'metric-cards',
    'kpi_cards': 'metric-cards',
    'numbers': 'metric-cards',
    'statistics': 'metric-cards',
    'data-points': 'metric-cards',
    'data_points': 'metric-cards',
    'datapoints': 'metric-cards',

    // Process components -> process-flow
    'flow': 'process-flow',
    'timeline': 'process-flow',
    'steps': 'process-flow',
    'process': 'process-flow',
    'workflow': 'process-flow',
    'sequence': 'process-flow',
    'step-flow': 'process-flow',
    'step_flow': 'process-flow',
    'stepflow': 'process-flow',

    // Icon components -> icon-grid
    'icon': 'icon-grid', // Common abbreviation the model generates
    'icons': 'icon-grid',
    'grid': 'icon-grid',
    'features': 'icon-grid',
    'benefits': 'icon-grid',
    'capabilities': 'icon-grid',
    'icon-list': 'icon-grid',
    'icon_list': 'icon-grid',
    'iconlist': 'icon-grid',

    // Chart components -> chart-frame
    'chart': 'chart-frame',
    'graph': 'chart-frame',
    'data': 'chart-frame',
    'visualization': 'chart-frame',
    'viz': 'chart-frame',
    'bar-chart': 'chart-frame',
    'bar_chart': 'chart-frame',
    'barchart': 'chart-frame',
    'pie-chart': 'chart-frame',
    'pie_chart': 'chart-frame',
    'piechart': 'chart-frame',
    'line-chart': 'chart-frame',
    'line_chart': 'chart-frame',
    'linechart': 'chart-frame',

    // Diagram components -> diagram-svg
    'diagram': 'diagram-svg',
    'infographic': 'diagram-svg',
    'visual-diagram': 'diagram-svg',
    'visual_diagram': 'diagram-svg',
    'visualdiagram': 'diagram-svg',
    'ecosystem-diagram': 'diagram-svg',
    'ecosystem_diagram': 'diagram-svg',
    'ecosystemdiagram': 'diagram-svg',
    'circular-diagram': 'diagram-svg',
    'circular_diagram': 'diagram-svg',
    'circulardiagram': 'diagram-svg',
    'cycle': 'diagram-svg',
    'ecosystem': 'diagram-svg'
};

const SUPPORTED_COMPONENT_TYPES = ['text-bullets', 'metric-cards', 'process-flow', 'icon-grid', 'chart-frame', 'diagram-svg'];

/**
 * Normalizes an array item that might be a string, JSON string, or object.
 * Returns a proper object with expected properties.
 */
function normalizeArrayItem(item: any, idx: number, expectedType: 'metric' | 'step' | 'item'): any {
    // If already a valid object with expected properties, return as-is
    if (typeof item === 'object' && item !== null) {
        return item;
    }

    // If it's a string, try to parse as JSON first
    if (typeof item === 'string') {
        // Try parsing as JSON (handles '{"value": ">300%", "label": "..."}')
        try {
            const parsed = JSON.parse(item);
            if (typeof parsed === 'object' && parsed !== null) {
                return parsed;
            }
        } catch {
            // Not valid JSON, treat as plain text
        }

        // Convert plain string to appropriate object based on expected type
        const text = item.trim();

        if (expectedType === 'metric') {
            return {
                value: text.length > 20 ? text.substring(0, 10) + '...' : text,
                label: `Metric ${idx + 1}`,
                icon: null // Will be filled by repair
            };
        } else if (expectedType === 'step') {
            return {
                number: idx + 1,
                title: text.length > 30 ? text.substring(0, 30) : text,
                description: text.length > 30 ? text : '',
                icon: null
            };
        } else { // item (icon-grid)
            return {
                label: text.length > 40 ? text.substring(0, 40) : text,
                icon: null
            };
        }
    }

    // Fallback for any other type
    return {
        label: `Item ${idx + 1}`,
        value: String(item ?? ''),
        icon: null
    };
}

/**
 * Deep-repairs JSON strings that might be nested in component data
 */
function deepParseJsonStrings(obj: any): any {
    if (typeof obj === 'string') {
        try {
            const parsed = JSON.parse(obj);
            return deepParseJsonStrings(parsed);
        } catch {
            return obj;
        }
    }
    if (Array.isArray(obj)) {
        return obj.map(item => deepParseJsonStrings(item));
    }
    if (typeof obj === 'object' && obj !== null) {
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = deepParseJsonStrings(value);
        }
        return result;
    }
    return obj;
}

export function autoRepairSlide(slide: SlideNode): SlideNode {
    // --- LAYER 5: Top-level field normalization (zero-cost rescue) ---

    const CONTENT_LIMITS = {
        title: 70,
        bullet: 120,
        metricValue: 10,
        metricLabel: 20,
        stepTitle: 15,
        stepDescription: 70,
        iconLabel: 20,
        iconDescription: 60,
        chartLabel: 18
    };

    const LIST_LIMITS = {
        textBullets: 4,
        metricCards: 3,
        processSteps: 4,
        iconGrid: 5
    };

    const ensureWarnings = () => {
        if (!slide.warnings) slide.warnings = [];
    };

    const addWarning = (msg: string) => {
        ensureWarnings();
        if (!slide.warnings!.includes(msg)) slide.warnings!.push(msg);
    };

    const truncateText = (text: string, max: number, label?: string) => {
        if (!text || typeof text !== 'string') return text;
        if (text.length <= max) return text;
        const trimmed = text.substring(0, Math.max(0, max - 1)).trimEnd() + '…';
        if (label) addWarning(`Auto-trimmed ${label} to ${max} chars`);
        return trimmed;
    };

    const capList = <T>(list: T[], max: number, label?: string): T[] => {
        if (!Array.isArray(list)) return list;
        if (list.length <= max) return list;
        if (label) addWarning(`Auto-trimmed ${label} to ${max} items`);
        return list.slice(0, max);
    };

    // Fix malformed selfCritique (model outputs prose in layoutAction instead of enum)
    if (slide.selfCritique) {
        if (typeof slide.selfCritique === 'string') {
            // Model returned string instead of object
            console.warn(`[AUTO-REPAIR] selfCritique was string, converting to object`);
            slide.selfCritique = {
                layoutAction: 'keep',
                readabilityScore: 8,
                textDensityStatus: 'optimal' as any
            };
        } else {
            // Validate/normalize fields
            const sc = slide.selfCritique as any;

            // layoutAction: If prose text, extract intent or default to 'keep'
            if (sc.layoutAction && typeof sc.layoutAction === 'string') {
                const action = sc.layoutAction.toLowerCase();
                if (action.includes('simplif')) sc.layoutAction = 'simplify' as any;
                else if (action.includes('shrink') || action.includes('reduce')) sc.layoutAction = 'shrink_text' as any;
                else if (action.includes('visual') || action.includes('add')) sc.layoutAction = 'add_visuals' as any;
                else if (!['keep', 'simplify', 'shrink_text', 'add_visuals'].includes(action)) {
                    console.warn(`[AUTO-REPAIR] layoutAction was prose: "${sc.layoutAction.slice(0, 50)}...", defaulting to 'keep'`);
                    sc.layoutAction = 'keep' as any;
                }
            } else {
                sc.layoutAction = 'keep' as any;
            }

            // readabilityScore: Ensure number 0-10
            if (typeof sc.readabilityScore !== 'number' || sc.readabilityScore < 0 || sc.readabilityScore > 10) {
                sc.readabilityScore = 8;
            }

            // textDensityStatus: Normalize to enum
            if (sc.textDensityStatus && typeof sc.textDensityStatus === 'string') {
                const status = sc.textDensityStatus.toLowerCase();
                if (status.includes('optim')) sc.textDensityStatus = 'optimal' as any;
                else if (status.includes('high') || status.includes('dens')) sc.textDensityStatus = 'high' as any;
                else if (status.includes('over')) sc.textDensityStatus = 'overflow' as any;
                else sc.textDensityStatus = 'optimal' as any;
            } else {
                sc.textDensityStatus = 'optimal' as any;
            }
        }
    }

    // Fix missing/malformed speakerNotesLines (model sometimes outputs "" or garbage)
    if (!slide.speakerNotesLines || !Array.isArray(slide.speakerNotesLines)) {
        console.warn(`[AUTO-REPAIR] speakerNotesLines missing or invalid, generating default`);
        slide.speakerNotesLines = [`Slide: ${slide.title || 'Content'}`];
    } else {
        // Filter out empty strings and garbage entries
        slide.speakerNotesLines = slide.speakerNotesLines
            .filter((line: any) => typeof line === 'string' && line.trim().length > 0)
            .slice(0, 5); // Limit to 5 notes

        if (slide.speakerNotesLines.length === 0) {
            slide.speakerNotesLines = [`Slide: ${slide.title || 'Content'}`];
        }
    }

    let components = slide.layoutPlan?.components || [];
    const SAFE_ICONS = ['Activity', 'Zap', 'BarChart3', 'Box', 'Layers', 'PieChart', 'TrendingUp', 'Target', 'CheckCircle', 'Lightbulb'];

    const isGarbage = (text: string) => {
        if (!text || typeof text !== 'string' || text.length < 20) return false;
        const words = text.split(/\s+/);
        if (words.length > 5) {
            const uniqueWords = new Set(words.map(w => w.toLowerCase()));
            if (uniqueWords.size < words.length * 0.5) return true;
        }
        return false;
    };

    const isPlaceholderValue = (value: any) => {
        if (value === null || value === undefined) return true;
        const raw = String(value).trim().toLowerCase();
        if (!raw) return true;
        return [
            'n/a', 'na', 'tbd', 'unknown', 'none', 'null', 'nil', 'not available',
            '-', '—', '...', 'n.a.'
        ].includes(raw);
    };

    const extractFallbackBullets = () => {
        const bullets: string[] = [];
        const add = (text?: string) => {
            if (!text || typeof text !== 'string') return;
            const clean = text.replace(/^slide:\s*/i, '').trim();
            if (clean.length >= 6) bullets.push(clean);
        };

        if (Array.isArray(slide.content)) {
            slide.content.forEach(line => add(line));
        }

        if (Array.isArray(slide.speakerNotesLines)) {
            slide.speakerNotesLines.slice(0, 2).forEach(line => add(line));
        }

        add(slide.layoutPlan?.title as any);
        add((slide as any).title);

        const unique = Array.from(new Set(bullets));
        const titleText = String(slide.layoutPlan?.title || (slide as any).title || '').trim();
        if (titleText) {
            const titleLower = titleText.toLowerCase();
            const nonTitle = unique.filter(item => String(item).trim().toLowerCase() !== titleLower);
            if (nonTitle.length > 0) return nonTitle.slice(0, 4);
        }
        return unique.slice(0, 4);
    };

    const convertMetricsToTextBullets = (component: any, reason: string) => {
        const fallback = extractFallbackBullets();
        const safeBullets = fallback.length > 0
            ? fallback
            : ['Key focus areas', 'Operational priorities', 'Expected outcomes'];

        component.type = 'text-bullets';
        component.title = component.title || 'Key Points';
        component.content = safeBullets;
        delete component.metrics;
        delete component.items;
        delete component.cards;
        addWarning(`Converted metric-cards to text-bullets: ${reason}`);
    };

    const convertIconGridToTextBullets = (component: any, reason: string) => {
        const fallback = extractFallbackBullets();
        const safeBullets = fallback.length > 0
            ? fallback
            : ['Core capability', 'Primary benefit', 'Key outcome'];

        component.type = 'text-bullets';
        component.title = component.title || 'Key Points';
        component.content = safeBullets;
        delete component.items;
        delete component.icons;
        delete component.features;
        addWarning(`Converted icon-grid to text-bullets: ${reason}`);
    };

    const convertChartFrameToTextBullets = (component: any, reason: string) => {
        const fallback = extractFallbackBullets();
        const safeBullets = fallback.length > 0
            ? fallback
            : ['Key data signal', 'Supporting evidence', 'Impact highlight'];

        component.type = 'text-bullets';
        component.title = component.title || 'Key Points';
        component.content = safeBullets;
        delete component.data;
        addWarning(`Converted chart-frame to text-bullets: ${reason}`);
    };

    const normalizeComponentType = (rawType: string | undefined | null): string => {
        if (!rawType || typeof rawType !== 'string') return 'text-bullets';
        const trimmed = rawType.trim();
        if (!trimmed) return 'text-bullets';

        const lower = trimmed.toLowerCase();
        if (SUPPORTED_COMPONENT_TYPES.includes(lower)) return lower;

        const directMapped = COMPONENT_TYPE_MAP[lower];
        if (directMapped) return directMapped;

        // Extract first recognizable type from noisy/concatenated strings
        const priority = ['text-bullets', 'metric-cards', 'process-flow', 'icon-grid', 'chart-frame', 'diagram-svg'];
        for (const type of priority) {
            if (lower.includes(type)) return type;
        }
        for (const [key, mapped] of Object.entries(COMPONENT_TYPE_MAP)) {
            if (lower.includes(key)) return mapped;
        }

        return 'text-bullets';
    };

    // STEP 1: Normalize component types (FIX: Handle undefined/null types)
    // Pre-check: Some model outputs embed entire JSON blobs into the type string
    // Attempt to extract a valid layoutPlan if detected
    const tryRecoverEmbeddedLayout = (value: string): boolean => {
        if (!value || typeof value !== 'string') return false;
        if (!value.includes('{') || !value.toLowerCase().includes('layoutplan')) return false;

        const start = value.indexOf('{');
        const end = value.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) return false;

        const candidate = value.substring(start, end + 1);
        try {
            const parsed = JSON.parse(candidate);
            if (parsed?.layoutPlan?.components && Array.isArray(parsed.layoutPlan.components)) {
                slide.layoutPlan = {
                    ...slide.layoutPlan,
                    ...parsed.layoutPlan
                } as any;
                return true;
            }
        } catch {
            return false;
        }
        return false;
    };
    for (const c of components) {
        if (c?.type && typeof c.type === 'string') {
            const recovered = tryRecoverEmbeddedLayout(c.type);
            if (recovered && slide.layoutPlan?.components) {
                components = slide.layoutPlan.components as any;
                break;
            }
        }
    }

    components.forEach((c: any, idx: number) => {
        // FIX: Handle undefined, null, or missing type
        if (!c.type || typeof c.type !== 'string') {
            console.warn(`[AUTO-REPAIR] Component ${idx} has undefined/invalid type, defaulting to 'text-bullets'`);
            c.type = 'text-bullets';

            // Try to extract content from any available property
            if (!c.content) {
                c.content = [];
                // Check common property names that might contain content
                const contentSources = ['text', 'body', 'paragraph', 'items', 'value', 'label', 'description'];
                for (const prop of contentSources) {
                    if (c[prop]) {
                        if (Array.isArray(c[prop])) {
                            c.content.push(...c[prop].map((x: any) => typeof x === 'string' ? x : JSON.stringify(x)));
                        } else if (typeof c[prop] === 'string') {
                            c.content.push(c[prop]);
                        }
                    }
                }
                if (c.content.length === 0) {
                    c.content = [`Content from component ${idx + 1}`];
                }
            }
        } else if (!SUPPORTED_COMPONENT_TYPES.includes(c.type)) {
            const normalizedType = normalizeComponentType(c.type);
            if (normalizedType !== c.type) {
                console.warn(`[AUTO-REPAIR] Normalized component type '${c.type}' -> '${normalizedType}'`);
                c.type = normalizedType;
            }

            if (!SUPPORTED_COMPONENT_TYPES.includes(c.type)) {
                // Unknown type - default to text-bullets and try to salvage content
                console.warn(`[AUTO-REPAIR] Unknown component type '${c.type}', converting to 'text-bullets'`);
                const oldType = c.type;
                c.type = 'text-bullets';

                // Try to extract content from various possible properties
                if (!c.content) {
                    c.content = [];
                    if (c.text) c.content.push(String(c.text));
                    if (c.body) c.content.push(String(c.body));
                    if (c.paragraph) c.content.push(String(c.paragraph));
                    if (c.content.length === 0) {
                        c.content = [`Content from ${oldType} component`];
                    }
                }
            }
        }
    });

    // STEP 1.25: Layout feasibility check (prevent hard failures)
    const layoutVariantCandidate = slide.routerConfig?.layoutVariant;
    const densityMaxItems = slide.routerConfig?.densityBudget?.maxItems;
    const componentTypes = components.map((c: any) => c.type);

    const enforceLayoutFallback = (reason: string) => {
        addWarning(`Auto-rerouted layout to standard-vertical: ${reason}`);
        if (slide.routerConfig) slide.routerConfig.layoutVariant = 'standard-vertical' as any;
    };

    if (layoutVariantCandidate === 'bento-grid') {
        const hasGridType = componentTypes.some(t => t === 'metric-cards' || t === 'icon-grid');
        if (!hasGridType) {
            enforceLayoutFallback('bento-grid requires metric-cards or icon-grid');
        }
        if (components.length < 2) {
            enforceLayoutFallback('bento-grid requires at least 2 components');
        }
        if (typeof densityMaxItems === 'number' && densityMaxItems < 2) {
            enforceLayoutFallback('bento-grid incompatible with maxItems < 2');
        }
    }

    const capComponentsToLayout = (layoutVariant: string, componentList: any[]) => {
        const layoutComponentCaps: Record<string, number> = {
        'hero-centered': 1,
        'timeline-horizontal': 1,
        'split-left-text': 2,
        'split-right-text': 2,
        'standard-vertical': 2,
        'bento-grid': 3,
        'dashboard-tiles': 3,
        'metrics-rail': 2,
        'asymmetric-grid': 3
        };
        const maxComponents = layoutComponentCaps[layoutVariant] ?? 2;
        if (componentList.length > maxComponents) {
            const priorityOrder = layoutVariant === 'bento-grid'
                ? ['metric-cards', 'icon-grid', 'chart-frame', 'text-bullets', 'process-flow', 'diagram-svg']
                : ['text-bullets', 'chart-frame', 'metric-cards', 'process-flow', 'icon-grid', 'diagram-svg'];

            const priorityRank = (type: string) => {
                const idx = priorityOrder.indexOf(type);
                return idx >= 0 ? idx : priorityOrder.length + 1;
            };

            const trimmed = [...componentList]
                .sort((a: any, b: any) => priorityRank(a.type) - priorityRank(b.type))
                .slice(0, maxComponents);

            addWarning(`Auto-trimmed components to ${maxComponents} for layout ${layoutVariant}`);
            return trimmed;
        }
        return componentList;
    };

    const consolidateTextBullets = (layoutVariant: string, componentList: any[]) => {
        const textComponents = componentList.filter(c => c.type === 'text-bullets');
        if (textComponents.length <= 1) return componentList;

        const maxTextComponents = ['standard-vertical', 'dashboard-tiles', 'asymmetric-grid'].includes(layoutVariant) ? 2 : 1;
        const hasDuplicates = textComponents.some((a: any, idx: number) => {
            const aKey = `${String(a.title || '').trim().toLowerCase()}|${(a.content || []).map((s: any) => String(s).trim().toLowerCase()).join('||')}`;
            return textComponents.slice(idx + 1).some((b: any) => {
                const bKey = `${String(b.title || '').trim().toLowerCase()}|${(b.content || []).map((s: any) => String(s).trim().toLowerCase()).join('||')}`;
                return aKey === bKey;
            });
        });

        if (textComponents.length <= maxTextComponents && !hasDuplicates) return componentList;

        const merged = textComponents[0];
        const mergedContent: string[] = [];
        const seen = new Set<string>();

        textComponents.forEach((comp: any) => {
            const items = Array.isArray(comp.content) ? comp.content : [];
            items.forEach((item: any) => {
                const norm = String(item).trim();
                const key = norm.toLowerCase();
                if (norm && !seen.has(key)) {
                    seen.add(key);
                    mergedContent.push(norm);
                }
            });
        });

        const layoutBulletCaps: Record<string, number> = {
            'split-left-text': 2,
            'split-right-text': 2,
            'asymmetric-grid': 3,
            'bento-grid': 2,
            'metrics-rail': 2,
            'hero-centered': 2,
            'dashboard-tiles': 2,
            'timeline-horizontal': 3,
            'standard-vertical': LIST_LIMITS.textBullets
        };
        const layoutCap = layoutBulletCaps[layoutVariant] ?? LIST_LIMITS.textBullets;
        merged.title = merged.title || 'Key Points';
        merged.content = capList(mergedContent.map(t => truncateText(t, CONTENT_LIMITS.bullet, 'bullet text')), layoutCap, 'bullet items');

        addWarning(`Auto-merged ${textComponents.length} text-bullets components`);
        return componentList.filter(c => c.type !== 'text-bullets').concat([merged]);
    };

    // STEP 1.5: Cap components to layout capacity (prevents unplaced components)
    const layoutVariant = slide.routerConfig?.layoutVariant || 'standard-vertical';
    components = capComponentsToLayout(layoutVariant, components);
    if (slide.layoutPlan) {
        slide.layoutPlan.components = components as any;
    }

    // STEP 2: Normalize and repair component data
    components.forEach((c: any) => {
        // Deep-parse any JSON strings in the component
        if (c.metrics) c.metrics = deepParseJsonStrings(c.metrics);
        if (c.steps) c.steps = deepParseJsonStrings(c.steps);
        if (c.items) c.items = deepParseJsonStrings(c.items);
        if (c.data) c.data = deepParseJsonStrings(c.data);

        if (c.type === 'metric-cards') {
            // Model might use 'items' or 'metrics' - normalize to 'metrics'
            let list: any[] = c.metrics || c.items || c.cards || [];
            if (!Array.isArray(list)) list = [list];

            // If array is empty, convert to text-bullets instead of injecting placeholders
            if (list.length === 0) {
                console.warn(`[AUTO-REPAIR] Empty metric-cards array, converting to text-bullets`);
                convertMetricsToTextBullets(c, 'no metrics available');
                return;
            }

            // Normalize each item
            list = list.map((item, idx) => normalizeArrayItem(item, idx, 'metric'));

            // Repair icons and garbage
            list.forEach((item, idx) => {
                if (typeof item === 'object' && item !== null) {
                    if (!item.icon || item.icon === '' || item.icon === 'N/A') {
                        item.icon = SAFE_ICONS[idx % SAFE_ICONS.length];
                    }
                    if (item.label && isGarbage(item.label)) {
                        item.label = "Metric " + (idx + 1);
                    }

                    // Ensure value exists without placeholder injection
                    if (isPlaceholderValue(item.value)) {
                        item.value = '';
                    }

                    if (isPlaceholderValue(item.label)) {
                        item.label = '';
                    }

                    item.value = truncateText(String(item.value), CONTENT_LIMITS.metricValue, 'metric value');
                    item.label = truncateText(String(item.label || ''), CONTENT_LIMITS.metricLabel, 'metric label');
                }
            });

            // Drop placeholder or empty metrics
            list = list.filter(item => {
                if (!item || typeof item !== 'object') return false;
                const valueOk = !isPlaceholderValue(item.value) && String(item.value).trim().length > 0;
                const labelOk = !isPlaceholderValue(item.label) && String(item.label).trim().length > 0;
                return valueOk && labelOk;
            });

            // If we don't have enough valid metrics, convert to text-bullets
            if (list.length < 2) {
                console.warn(`[AUTO-REPAIR] Insufficient valid metrics (${list.length}), converting to text-bullets`);
                convertMetricsToTextBullets(c, 'insufficient valid metrics');
                return;
            }

            const maxItems = Math.min(LIST_LIMITS.metricCards, slide.routerConfig?.densityBudget?.maxItems || LIST_LIMITS.metricCards);
            list = capList(list, maxItems, 'metric cards');

            c.metrics = list;
            // Clean up alternative property names
            delete c.items;
            delete c.cards;
        }

        if (c.type === 'process-flow') {
            let list: any[] = c.steps || [];
            if (!Array.isArray(list)) list = [list];

            list = list.map((item, idx) => normalizeArrayItem(item, idx, 'step'));

            list.forEach((item, idx) => {
                if (typeof item === 'object' && item !== null) {
                    if (!item.icon || item.icon === '') {
                        item.icon = SAFE_ICONS[idx % SAFE_ICONS.length];
                    }
                    if (!item.number) item.number = idx + 1;
                    if (item.title && isGarbage(item.title)) {
                        item.title = "Step " + (idx + 1);
                    }

                    if (item.title) {
                        item.title = truncateText(String(item.title), CONTENT_LIMITS.stepTitle, 'step title');
                    }
                    if (item.description) {
                        item.description = truncateText(String(item.description), CONTENT_LIMITS.stepDescription, 'step description');
                    }
                }
            });

            const maxItems = Math.min(LIST_LIMITS.processSteps, slide.routerConfig?.densityBudget?.maxItems || LIST_LIMITS.processSteps);
            list = capList(list, maxItems, 'process steps');

            c.steps = list;
        }

        if (c.type === 'icon-grid') {
            // Model might use 'icons' or 'features' - normalize to 'items'
            let list: any[] = c.items || c.icons || c.features || [];
            if (!Array.isArray(list)) list = [list];

            // If array is empty, convert to text-bullets instead of placeholders
            if (list.length === 0) {
                console.warn(`[AUTO-REPAIR] Empty icon-grid array, converting to text-bullets`);
                convertIconGridToTextBullets(c, 'no icon items available');
                return;
            }

            list = list.map((item, idx) => normalizeArrayItem(item, idx, 'item'));

            list.forEach((item, idx) => {
                if (typeof item === 'object' && item !== null) {
                    if (!item.icon || item.icon === '' || item.icon === 'N/A') {
                        item.icon = SAFE_ICONS[idx % SAFE_ICONS.length];
                    }
                    if (item.label && isGarbage(item.label)) {
                        item.label = "Feature " + (idx + 1);
                    }
                    // Ensure label exists
                    if (!item.label) {
                        item.label = "Feature " + (idx + 1);
                    }

                    if (item.label) {
                        item.label = truncateText(String(item.label), CONTENT_LIMITS.iconLabel, 'icon label');
                    }
                    if (item.description) {
                        item.description = truncateText(String(item.description), CONTENT_LIMITS.iconDescription, 'icon description');
                    }
                }
            });

            const maxItems = Math.min(LIST_LIMITS.iconGrid, slide.routerConfig?.densityBudget?.maxItems || LIST_LIMITS.iconGrid);
            list = capList(list, maxItems, 'icon grid items');

            c.items = list;
            // Clean up alternative property names
            delete c.icons;
            delete c.features;
        }

        if (c.type === 'text-bullets') {
            // Ensure content is an array of strings
            if (!Array.isArray(c.content)) {
                if (typeof c.content === 'string') {
                    c.content = [c.content];
                } else {
                    c.content = [];
                }
            }

            if (c.title && typeof c.title === 'string') {
                c.title = truncateText(c.title, CONTENT_LIMITS.title, 'text-bullets title');
            }

            const unique = new Set();
            const cleanContent: string[] = [];
            const rawItems = Array.isArray(c.content) ? c.content : [];
            const bulletCount = rawItems.length;
            c.content.forEach((s: any) => {
                // Convert non-strings to strings
                let text = typeof s === 'string' ? s : JSON.stringify(s);
                let norm = text.trim();
                if (isGarbage(norm)) {
                    norm = norm.substring(0, 50) + "...";
                }
                const layoutVariantForText = slide.routerConfig?.layoutVariant || 'standard-vertical';
                const layoutBulletCaps: Record<string, number> = {
                    'split-left-text': 2,
                    'split-right-text': 2,
                    'asymmetric-grid': 3,
                    'bento-grid': 2,
                    'metrics-rail': 2,
                    'hero-centered': 2,
                    'dashboard-tiles': 2,
                    'timeline-horizontal': 3,
                    'standard-vertical': LIST_LIMITS.textBullets
                };
                const layoutBulletCharCaps: Record<string, number> = {
                    'split-left-text': 55,
                    'split-right-text': 55,
                    'asymmetric-grid': 60,
                    'bento-grid': 50,
                    'metrics-rail': 55,
                    'hero-centered': 50,
                    'dashboard-tiles': 50,
                    'timeline-horizontal': 55,
                    'standard-vertical': 70
                };
                const densityMaxChars = slide.routerConfig?.densityBudget?.maxChars;
                const densityMaxItems = slide.routerConfig?.densityBudget?.maxItems || LIST_LIMITS.textBullets;
                const perItemDensity = densityMaxChars ? Math.floor(densityMaxChars / Math.max(1, densityMaxItems)) : undefined;
                const baseCap = layoutBulletCharCaps[layoutVariantForText] ?? 70;
                const countAdjustedCap = bulletCount >= 3 ? Math.min(baseCap, 55) : baseCap;
                const bulletCharCap = Math.max(40, Math.min(countAdjustedCap, perItemDensity || countAdjustedCap));

                norm = truncateText(norm, bulletCharCap, 'bullet text');
                const key = norm.toLowerCase();
                if (!unique.has(key) && norm.length > 0) {
                    unique.add(key);
                    cleanContent.push(norm);
                }
            });
            const layoutVariantForText = slide.routerConfig?.layoutVariant || 'standard-vertical';
            const layoutBulletCaps: Record<string, number> = {
                'split-left-text': 2,
                'split-right-text': 2,
                'asymmetric-grid': 3,
                'bento-grid': 2,
                'metrics-rail': 2,
                'hero-centered': 2,
                'dashboard-tiles': 2,
                'timeline-horizontal': 3,
                'standard-vertical': LIST_LIMITS.textBullets
            };
            const layoutCap = layoutBulletCaps[layoutVariantForText] ?? LIST_LIMITS.textBullets;
            const maxItems = Math.min(layoutCap, slide.routerConfig?.densityBudget?.maxItems || LIST_LIMITS.textBullets);
            c.content = capList(cleanContent, maxItems, 'bullet items');
        }

        if (c.type === 'chart-frame' && c.data) {
            // Normalize chart data
            if (!Array.isArray(c.data)) c.data = [];
            c.data = c.data.map((d: any, idx: number) => {
                if (typeof d === 'string') {
                    try {
                        return JSON.parse(d);
                    } catch {
                        return { label: d, value: (idx + 1) * 10 };
                    }
                }
                return d;
            }).filter((d: any) => d && typeof d.value === 'number')
                .map((d: any) => ({
                    ...d,
                    label: truncateText(String(d.label || ''), CONTENT_LIMITS.chartLabel, 'chart label')
                }));

            if (!c.data || c.data.length === 0) {
                console.warn(`[AUTO-REPAIR] Empty chart-frame data, converting to text-bullets`);
                convertChartFrameToTextBullets(c, 'no data available');
            }
        }
    });

    // STEP 2.5: Consolidate text components and re-cap after conversions
    const postVariant = slide.routerConfig?.layoutVariant || 'standard-vertical';
    components = consolidateTextBullets(postVariant, components);
    components = capComponentsToLayout(postVariant, components);

    if (slide.layoutPlan) {
        slide.layoutPlan.components = components as any;
    }

    // STEP 3: Post-normalization layout sanity check (after conversions)
    const finalVariant = slide.routerConfig?.layoutVariant || 'standard-vertical';
    const finalTypes = (slide.layoutPlan?.components || []).map((c: any) => c.type);
    const hasGrid = finalTypes.some(t => t === 'metric-cards' || t === 'icon-grid');
    const componentCount = finalTypes.length;

    const enforceFinalFallback = (reason: string) => {
        addWarning(`Auto-rerouted layout to standard-vertical: ${reason}`);
        if (slide.routerConfig) slide.routerConfig.layoutVariant = 'standard-vertical' as any;
    };

    if (['bento-grid', 'dashboard-tiles', 'metrics-rail'].includes(finalVariant)) {
        if (!hasGrid) {
            enforceFinalFallback(`${finalVariant} requires metric-cards or icon-grid`);
        }
        if (componentCount < 2) {
            enforceFinalFallback(`${finalVariant} requires at least 2 components`);
        }
    }

    const hasDiagram = finalTypes.includes('diagram-svg');
    if (hasDiagram && !['split-left-text', 'split-right-text', 'asymmetric-grid'].includes(finalVariant)) {
        if (slide.routerConfig) {
            slide.routerConfig.layoutVariant = 'split-right-text' as any;
        }
        addWarning(`Auto-rerouted layout to split-right-text: diagram-svg needs a dedicated visual zone`);
    }

    if (['split-left-text', 'split-right-text'].includes(finalVariant) && componentCount < 2) {
        enforceFinalFallback(`${finalVariant} requires 2 components`);
    }

    return slide;
}
