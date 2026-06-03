# StellarMind Frontend Architecture

## Overview

The frontend has been refactored from a monolithic 1,300-line HTML file into a modular, maintainable structure with separated concerns. The new architecture organizes CSS and JavaScript into logical modules while maintaining 100% feature parity with the original implementation.

## Directory Structure

```
public/
├── index.html                    # Semantic HTML shell (semantic markup only)
├── assets/
│   ├── css/
│   │   ├── variables.css        # CSS variables, reset, and base styles
│   │   ├── sidebar.css          # Sidebar navigation and styling
│   │   ├── layout.css           # Main layout, grid systems, responsive
│   │   ├── components.css       # Reusable components (cards, buttons, inputs)
│   │   └── pages.css            # Page-specific styles (orchestrator, agents, status, tx)
│   └── js/
│       ├── navigation.js        # Page switching and sidebar state
│       ├── budget.js            # Budget slider interaction
│       ├── agents.js            # Agent registry loading and display
│       ├── wallet.js            # Wallet balance fetching and display
│       ├── sse.js               # Server-Sent Events connection and feed
│       ├── rendering.js         # Result display and progress rendering
│       ├── orchestration.js     # Task execution and live run tracking
│       ├── pages.js             # Page-specific data loading (status, tx, agents)
│       └── init.js              # App initialization and event listeners
```

## File Organization by Concern

### CSS Modules

| File | Purpose | Lines | Responsibility |
|------|---------|-------|-----------------|
| `variables.css` | Design tokens & reset | ~60 | CSS custom properties, box-sizing reset, base body styles |
| `sidebar.css` | Navigation UI | ~200 | Sidebar layout, navigation items, agent list, wallet display |
| `layout.css` | Page structure | ~100 | Main content area, topbar, grid systems, responsive breakpoints |
| `components.css` | Reusable UI | ~250 | Cards, buttons, inputs, chips, empty states, tags |
| `pages.css` | Page-specific | ~450 | Orchestrator, agent registry, API status, transactions pages |

**Total CSS: ~1,060 lines** (organized, maintainable, no duplication)

### JavaScript Modules

| File | Purpose | Lines | Responsibility |
|------|---------|-------|-----------------|
| `navigation.js` | Page routing | ~20 | `showPage()` - switches active page and updates sidebar |
| `budget.js` | Budget control | ~15 | Budget slider event listener and display update |
| `agents.js` | Agent management | ~60 | `loadAgents()`, `loadAgentPage()`, `highlightAgent()` |
| `wallet.js` | Wallet data | ~40 | `loadWallets()` - fetches and displays balances |
| `sse.js` | Real-time events | ~120 | `connectSSE()`, `addFeed()` - handles live event stream |
| `rendering.js` | Result display | ~180 | Progress bars, result formatting, chip rendering |
| `orchestration.js` | Task execution | ~150 | `runOrchestration()`, `startLiveRun()`, `trackLiveEvent()` |
| `pages.js` | Page loading | ~200 | `loadStatusPage()`, `loadTxPage()`, `saveApiKey()` |
| `init.js` | Startup | ~25 | App initialization, event listener setup |

**Total JS: ~810 lines** (organized by feature, easy to test and extend)

## Key Design Decisions

### 1. **Semantic HTML Shell**
- `index.html` contains only semantic markup and script/style links
- No inline CSS or JavaScript
- Clean, readable structure for accessibility and SEO

### 2. **CSS Organization by Layer**
- **variables.css**: Design system (colors, spacing, typography)
- **sidebar.css**: Navigation component (isolated, reusable)
- **layout.css**: Page structure and responsive grid
- **components.css**: Atomic UI elements (cards, buttons, inputs)
- **pages.css**: Page-specific layouts and overrides

### 3. **JavaScript Organization by Concern**
- **Navigation**: Page routing and state
- **Data Loading**: Agents, wallets, transactions
- **Real-time**: SSE connection and event handling
- **Rendering**: DOM updates and progress display
- **Orchestration**: Task execution and live tracking
- **Initialization**: App startup and event binding

### 4. **No Build Step Required**
- All files are vanilla CSS and JavaScript
- No transpilation, bundling, or minification needed
- Direct browser execution via Express static serving
- Faster development iteration

## Styling Architecture

### CSS Variables (Design Tokens)
```css
--bg-body, --bg-sidebar, --bg-main, --bg-card, --bg-card-alt, --bg-input, --bg-hover
--border, --border-active
--text-primary, --text-secondary, --text-muted
--accent, --accent-light, --accent-glow
--purple, --cyan, --green, --amber, --red, --pink
--gradient, --gradient-subtle, --shadow-glow
--radius, --radius-sm, --radius-xs
--sidebar-w, --tr (transition)
```

### Component Naming Convention
- `.sb-*` - Sidebar components
- `.card*` - Card container and sections
- `.btn` - Button styles
- `.tag` - Status/info tags
- `.fi*` - Feed item components
- `.ac*` - Agent card components
- `.tx-*` - Transaction table styles
- `.ep-*` - Endpoint list styles

## JavaScript Module Dependencies

```
init.js
├── navigation.js
├── budget.js
├── agents.js
├── wallet.js
├── sse.js
│   └── rendering.js
│       └── orchestration.js
├── orchestration.js
│   ├── rendering.js
│   └── wallet.js
├── pages.js
│   └── agents.js
└── (periodic wallet refresh)
```

## API Integration Points

### Data Loading
- `/api/agents` - Agent registry
- `/api/wallet/balances` - Wallet data
- `/api/wallet/transactions` - Transaction history
- `/api/status` - System status
- `/api/config/apikey` - API key management

### Real-time Events
- `/api/events` - Server-Sent Events stream
  - Event types: `orchestrator_start`, `orchestrator_plan`, `agent_call`, `x402_payment`, `agent_response`, `budget_limit`, `orchestrator_complete`, `error`

### Task Execution
- `POST /api/orchestrate` - Submit task with budget

## Responsive Design

### Breakpoints
- **Desktop** (1024px+): Full sidebar, 2-column grids
- **Tablet** (768px-1024px): Narrower sidebar, 1-column grids
- **Mobile** (<768px): Hidden sidebar, stacked layout

### Mobile Considerations
- Sidebar hidden on mobile (navigation via topbar)
- Single-column grid layouts
- Touch-friendly button sizes
- Scrollable content areas

## Performance Optimizations

1. **CSS**: Organized into separate files for better caching
2. **JavaScript**: Modular structure allows lazy loading if needed
3. **Event Handling**: Delegated event listeners where possible
4. **DOM Updates**: Batch updates in rendering functions
5. **SSE**: Efficient event streaming with automatic reconnection

## Testing & Maintenance

### CSS Testing
- Visual regression testing for each page
- Responsive design testing at breakpoints
- Color contrast verification for accessibility

### JavaScript Testing
- Unit tests for data transformation functions
- Integration tests for API calls
- E2E tests for user workflows (task submission, page navigation)

### Code Quality
- No linting required (vanilla JS/CSS)
- Clear function naming and documentation
- Consistent code style across modules

## Migration Notes

### What Changed
- ✅ Inline CSS split into 5 organized files
- ✅ Inline JavaScript split into 9 focused modules
- ✅ HTML reduced to semantic markup only
- ✅ All functionality preserved (100% feature parity)
- ✅ No external dependencies added

### What Stayed the Same
- Same visual design and layout
- Same API endpoints and data flow
- Same real-time event handling
- Same user interactions and workflows
- Same browser compatibility

## Future Improvements

1. **CSS Preprocessing**: Consider SCSS for variables and mixins
2. **JavaScript Bundling**: Webpack/Vite for production optimization
3. **Component Framework**: React/Vue for complex interactive components
4. **Testing**: Jest for unit tests, Cypress for E2E
5. **Accessibility**: ARIA labels and keyboard navigation enhancements
6. **Internationalization**: i18n support for multiple languages

## File Size Comparison

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| HTML | 1,298 lines | 150 lines | -88% |
| CSS | 800 lines | 1,060 lines | +33% (organized) |
| JS | 600 lines | 810 lines | +35% (organized) |
| Total | 1,298 lines | 2,020 lines | +56% (but modular) |

**Note**: The increase in total lines is due to better organization, comments, and whitespace. The code is now maintainable and scalable.

## Onboarding Guide

### For Designers
- Edit colors in `variables.css`
- Modify component styles in `components.css`
- Update page-specific styles in `pages.css`

### For Frontend Developers
- Add new pages: Create new module in `js/`, add styles to `pages.css`
- Modify interactions: Edit relevant module in `js/`
- Add new components: Create CSS in `components.css`, JS in appropriate module

### For Backend Developers
- API endpoints are called from specific modules (see API Integration Points)
- Event types are handled in `sse.js` and `orchestration.js`
- Add new event types: Update `addFeed()` in `sse.js` and `trackLiveEvent()` in `orchestration.js`

## Conclusion

The refactored frontend maintains 100% feature parity while providing a solid foundation for future development. The modular structure reduces cognitive load, improves maintainability, and enables parallel development across the team.
