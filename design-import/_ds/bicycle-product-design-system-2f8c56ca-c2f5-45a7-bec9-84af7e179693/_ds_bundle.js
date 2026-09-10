/* @ds-bundle: {"format":4,"namespace":"BicycleProductDesignSystem_2f8c56","components":[{"name":"AISearchBar","sourcePath":"components/AISearchBar/AISearchBar.jsx"},{"name":"Badge","sourcePath":"components/Badge/Badge.jsx"},{"name":"Button","sourcePath":"components/Button/Button.jsx"},{"name":"ConnectionCard","sourcePath":"components/ConnectionCard/ConnectionCard.jsx"},{"name":"DataTable","sourcePath":"components/DataTable/DataTable.jsx"},{"name":"MODES","sourcePath":"components/ModeMenu/ModeMenu.jsx"},{"name":"ModeMenu","sourcePath":"components/ModeMenu/ModeMenu.jsx"},{"name":"SIDEBAR_ITEMS","sourcePath":"components/Sidebar/Sidebar.jsx"},{"name":"SIDEBAR_FOOTER_ITEMS","sourcePath":"components/Sidebar/Sidebar.jsx"},{"name":"Sidebar","sourcePath":"components/Sidebar/Sidebar.jsx"},{"name":"Toast","sourcePath":"components/Toast/Toast.jsx"},{"name":"TopNav","sourcePath":"components/TopNav/TopNav.jsx"}],"sourceHashes":{"components/AISearchBar/AISearchBar.jsx":"1245863ca1f2","components/Badge/Badge.jsx":"93ce27fa524f","components/Button/Button.jsx":"5319ac01421a","components/ConnectionCard/ConnectionCard.jsx":"1af89010d89b","components/DataTable/DataTable.jsx":"277427833c1e","components/ModeMenu/ModeMenu.jsx":"b78f160fca9c","components/Sidebar/Sidebar.jsx":"b43cc70fc0a3","components/Toast/Toast.jsx":"dccee789a8c6","components/TopNav/TopNav.jsx":"5ad620bd81a3","preview/tweaks-panel.jsx":"6591467622ed","ui_kits/bicycle-app/App.jsx":"9b94d9bf48e9"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.BicycleProductDesignSystem_2f8c56 = window.BicycleProductDesignSystem_2f8c56 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/Badge/Badge.jsx
try { (() => {
const TONES = {
  success: {
    bg: 'rgba(59,180,67,.16)',
    fg: '#3BB443'
  },
  warning: {
    bg: 'rgba(230,165,22,.16)',
    fg: '#E6A516'
  },
  danger: {
    bg: 'rgba(219,28,2,.18)',
    fg: '#FF4F36'
  },
  info: {
    bg: 'rgba(57,172,255,.16)',
    fg: '#39ACFF'
  },
  accent: {
    bg: 'rgba(0,193,159,.16)',
    fg: '#00C19F'
  },
  neutral: {
    bg: '#2F3842',
    fg: '#B7BCC9'
  }
};
function Badge({
  tone = 'neutral',
  dot = true,
  children
}) {
  const t = TONES[tone] || TONES.neutral;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      background: t.bg,
      color: t.fg,
      fontSize: 12,
      fontWeight: 500,
      lineHeight: '18px',
      padding: '2px 8px',
      borderRadius: 9999
    }
  }, dot && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: 999,
      background: t.fg
    }
  }), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/Badge/Badge.jsx", error: String((e && e.message) || e) }); }

// components/Button/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const VARIANTS = {
  primary: {
    background: '#1463B8',
    color: '#F4F4F4',
    hover: '#0083C1'
  },
  secondary: {
    background: '#2F3842',
    color: '#F4F4F4',
    hover: '#3B444D'
  },
  text: {
    background: 'transparent',
    color: '#39ACFF',
    hover: 'transparent'
  },
  danger: {
    background: '#DB1C02',
    color: '#F4F4F4',
    hover: '#FF4F36'
  }
};
function Button({
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  disabled,
  onClick,
  children,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const v = VARIANTS[variant] || VARIANTS.primary;
  const sm = size === 'sm';
  return /*#__PURE__*/React.createElement("button", _extends({
    onClick: disabled ? undefined : onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      border: 0,
      fontFamily: 'inherit',
      fontWeight: 500,
      fontSize: sm ? 12 : 14,
      lineHeight: '16px',
      borderRadius: sm ? 6 : 8,
      padding: variant === 'text' ? sm ? '4px 6px' : '8px 6px' : sm ? '4px 10px' : '8px 14px',
      background: disabled ? '#212B36' : hover ? v.hover : v.background,
      color: disabled ? '#696D77' : v.color,
      cursor: disabled ? 'not-allowed' : 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      transition: 'background .12s ease, color .12s ease',
      whiteSpace: 'nowrap'
    }
  }, rest), icon && /*#__PURE__*/React.createElement("i", {
    className: 'fa-regular fa-' + icon,
    style: {
      fontSize: sm ? 10 : 12
    }
  }), children, iconRight && /*#__PURE__*/React.createElement("i", {
    className: 'fa-regular fa-' + iconRight,
    style: {
      fontSize: sm ? 10 : 12
    }
  }));
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/Button/Button.jsx", error: String((e && e.message) || e) }); }

// components/ConnectionCard/ConnectionCard.jsx
try { (() => {
const STATUS_TONE = {
  connected: 'success',
  stale: 'warning',
  failed: 'danger'
};
function ConnectionCard({
  name,
  type,
  status = 'connected',
  rows,
  icon = 'database',
  syncedLabel = 'synced 4m ago'
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#212B36',
      border: '1px solid #2F3842',
      borderRadius: 12,
      padding: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      minWidth: 240
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 32,
      height: 32,
      borderRadius: 8,
      background: 'rgba(0,193,159,.12)',
      color: '#00C19F',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 14
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: 'fa-solid fa-' + icon
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      color: '#F4F4F4',
      fontWeight: 500
    }
  }, name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#8D8F92',
      fontFamily: "'JetBrains Mono',monospace"
    }
  }, type)), /*#__PURE__*/React.createElement(__ds_scope.Badge, {
    tone: STATUS_TONE[status] || 'neutral'
  }, status)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 16,
      fontSize: 12,
      color: '#B7BCC9'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#F4F4F4',
      fontVariantNumeric: 'tabular-nums',
      fontWeight: 500
    }
  }, rows), " rows"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: 'auto',
      color: '#696D77'
    }
  }, syncedLabel)));
}
Object.assign(__ds_scope, { ConnectionCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/ConnectionCard/ConnectionCard.jsx", error: String((e && e.message) || e) }); }

// components/DataTable/DataTable.jsx
try { (() => {
function Row({
  row,
  columns
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("tr", {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      background: hover ? '#2F3842' : 'transparent'
    }
  }, columns.map((c, j) => {
    const v = row[c.key];
    let content = v;
    let color = '#F4F4F4';
    if (c.kind === 'delta' && typeof v === 'number') {
      color = v > 0 ? '#3BB443' : v < 0 ? '#FF4F36' : '#B7BCC9';
      content = (v > 0 ? '+' : v < 0 ? '\u2212' : '') + Math.abs(v).toFixed(1) + '%';
    }
    if (c.kind === 'currency' && typeof v === 'number') content = '$' + v.toLocaleString();
    if (c.kind === 'muted') color = '#B7BCC9';
    return /*#__PURE__*/React.createElement("td", {
      key: j,
      style: {
        padding: '11px 14px',
        textAlign: c.align || 'left',
        color,
        borderBottom: '1px solid #2F3842'
      }
    }, c.render ? c.render(row) : content);
  }));
}
function DataTable({
  columns = [],
  rows = []
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#212B36',
      border: '1px solid #2F3842',
      borderRadius: 12,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: 13,
      fontVariantNumeric: 'tabular-nums',
      color: '#F4F4F4'
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, columns.map((c, i) => /*#__PURE__*/React.createElement("th", {
    key: i,
    style: {
      textAlign: c.align || 'left',
      background: 'rgba(108,132,157,.12)',
      borderTop: '1px solid rgba(108,132,157,.18)',
      borderBottom: '1px solid rgba(108,132,157,.18)',
      padding: '10px 14px',
      fontWeight: 500,
      color: '#B7BCC9',
      fontSize: 12
    }
  }, c.label)))), /*#__PURE__*/React.createElement("tbody", null, rows.map((r, i) => /*#__PURE__*/React.createElement(Row, {
    key: i,
    row: r,
    columns: columns
  })))));
}
Object.assign(__ds_scope, { DataTable });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/DataTable/DataTable.jsx", error: String((e && e.message) || e) }); }

// components/ModeMenu/ModeMenu.jsx
try { (() => {
const MODES = [{
  id: 'fast',
  icon: 'bolt',
  label: 'Fast',
  sub: 'Quick & direct'
}, {
  id: 'balanced',
  icon: 'scale-balanced',
  label: 'Balanced',
  sub: 'Smart, well-reasoned'
}, {
  id: 'deep',
  icon: 'brain',
  label: 'Deep',
  sub: 'Thorough, multi-step reasoning'
}];
function ModeRow({
  mode,
  selected,
  onPick
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", {
    onClick: () => onPick(mode.id),
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 12px',
      cursor: 'pointer',
      background: hover ? '#3B444D' : 'transparent'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 22,
      height: 22,
      borderRadius: 5,
      background: 'rgba(0,193,159,.15)',
      color: '#00C19F',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 10
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: 'fa-solid fa-' + mode.icon
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: '#F4F4F4'
    }
  }, mode.label), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#8D8F92',
      marginTop: 2
    }
  }, mode.sub)), selected && /*#__PURE__*/React.createElement("i", {
    className: "fa-solid fa-check",
    style: {
      color: '#00C19F',
      fontSize: 12
    }
  }));
}
function ModeMenu({
  value = 'fast',
  onChange,
  onDismiss,
  anchored = true
}) {
  const pick = id => {
    onChange && onChange(id);
    onDismiss && onDismiss();
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: anchored ? 'absolute' : 'relative',
      bottom: anchored ? 'calc(100% + 6px)' : undefined,
      left: anchored ? 0 : undefined,
      width: 240,
      background: '#2F3842',
      borderRadius: 8,
      boxShadow: '0 2px 12px rgba(0,0,0,.30)',
      padding: '8px 0',
      zIndex: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#8D8F92',
      padding: '6px 12px',
      textTransform: 'uppercase',
      letterSpacing: '.05em',
      fontFamily: "'JetBrains Mono',monospace"
    }
  }, "Reasoning mode"), MODES.map(m => /*#__PURE__*/React.createElement(ModeRow, {
    key: m.id,
    mode: m,
    selected: value === m.id,
    onPick: pick
  })));
}
Object.assign(__ds_scope, { MODES, ModeMenu });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/ModeMenu/ModeMenu.jsx", error: String((e && e.message) || e) }); }

// components/AISearchBar/AISearchBar.jsx
try { (() => {
function IconBtn({
  icon,
  title,
  onClick,
  solid = false,
  size = 12
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("button", {
    title: title,
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      width: 30,
      height: 30,
      borderRadius: 999,
      background: hover ? '#2F3842' : '#212B36',
      color: hover ? '#F4F4F4' : '#B7BCC9',
      border: 0,
      cursor: 'pointer',
      flexShrink: 0,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: size,
      transition: 'background .12s, color .12s'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: (solid ? 'fa-solid fa-' : 'fa-regular fa-') + icon
  }));
}
function AISearchBar({
  value = '',
  onChange,
  mode = 'fast',
  onModeChange,
  onSubmit,
  placeholder = 'Ask Bicycle AI'
}) {
  const [modeOpen, setModeOpen] = React.useState(false);
  const selected = __ds_scope.MODES.find(m => m.id === mode) || __ds_scope.MODES[0];
  const canSend = !!(value && value.trim());
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#0F1822',
      border: '1px solid #212B36',
      borderRadius: 12,
      padding: '14px 16px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("textarea", {
    value: value,
    onChange: e => onChange && onChange(e.target.value),
    onKeyDown: e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (canSend && onSubmit) onSubmit();
      }
    },
    placeholder: placeholder,
    rows: 1,
    style: {
      width: '100%',
      boxSizing: 'border-box',
      background: 'transparent',
      border: 0,
      outline: 0,
      resize: 'none',
      fontFamily: 'inherit',
      fontSize: 14,
      lineHeight: '20px',
      color: '#F4F4F4',
      padding: 0,
      minHeight: 20
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(IconBtn, {
    icon: "plus",
    title: "Attach",
    solid: true
  }), /*#__PURE__*/React.createElement(IconBtn, {
    icon: "crop",
    title: "Annotate",
    solid: true
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginLeft: 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setModeOpen(o => !o),
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      background: modeOpen ? '#2F3842' : '#212B36',
      color: '#F4F4F4',
      border: 0,
      cursor: 'pointer',
      padding: '6px 10px',
      borderRadius: 8,
      fontFamily: 'inherit',
      fontSize: 12,
      fontWeight: 500
    }
  }, selected.label, /*#__PURE__*/React.createElement("i", {
    className: "fa-solid fa-chevron-down",
    style: {
      color: '#8D8F92',
      fontSize: 9
    }
  })), modeOpen && /*#__PURE__*/React.createElement(__ds_scope.ModeMenu, {
    value: mode,
    onChange: onModeChange,
    onDismiss: () => setModeOpen(false)
  })), /*#__PURE__*/React.createElement(IconBtn, {
    icon: "microphone",
    title: "Voice",
    solid: true
  }), /*#__PURE__*/React.createElement("button", {
    onClick: canSend ? onSubmit : undefined,
    title: "Send",
    style: {
      width: 30,
      height: 30,
      borderRadius: 999,
      background: canSend ? '#1463B8' : '#2F3842',
      color: canSend ? '#F4F4F4' : '#696D77',
      border: 0,
      cursor: canSend ? 'pointer' : 'not-allowed',
      flexShrink: 0,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 11
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "fa-solid fa-paper-plane"
  })))));
}
Object.assign(__ds_scope, { AISearchBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/AISearchBar/AISearchBar.jsx", error: String((e && e.message) || e) }); }

// components/Sidebar/Sidebar.jsx
try { (() => {
const SIDEBAR_ITEMS = [{
  id: 'home',
  icon: 'house',
  label: 'Home'
}, {
  id: 'patterns',
  icon: 'table-cells-large',
  label: 'Patterns'
}, {
  id: 'chat',
  icon: 'wand-magic-sparkles',
  label: 'Chat'
}, {
  id: 'stories',
  icon: 'rectangle-list',
  label: 'Data Stories'
}, {
  id: 'alerts',
  icon: 'bolt',
  label: 'Alerts'
}, {
  id: 'dashboards',
  icon: 'chart-pie',
  label: 'Dashboards'
}, {
  id: 'model',
  icon: 'diagram-project',
  label: 'Data Model'
}, {
  id: 'context',
  icon: 'clipboard',
  label: 'Context'
}, {
  id: 'tools',
  icon: 'screwdriver-wrench',
  label: 'Tools'
}];
const SIDEBAR_FOOTER_ITEMS = [{
  id: 'profile',
  icon: 'user-gear',
  label: 'Profile'
}, {
  id: 'help',
  icon: 'circle-question',
  label: 'Help'
}];
function RailItem({
  item,
  active,
  onSelect
}) {
  const [hover, setHover] = React.useState(false);
  const tint = active ? '#00C19F' : hover ? '#F4F4F4' : '#8D8F92';
  return /*#__PURE__*/React.createElement("div", {
    onClick: () => onSelect && onSelect(item.id),
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      padding: '10px 4px',
      cursor: 'pointer',
      color: tint,
      fontSize: 10,
      fontWeight: 500,
      lineHeight: 1.15,
      textAlign: 'center',
      transition: 'color .12s'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 40,
      height: 34,
      borderRadius: 8,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: active ? 'rgba(0,193,159,.14)' : 'transparent',
      color: tint,
      transition: 'background .12s',
      fontSize: 18
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: 'fa-solid fa-' + item.icon
  })), item.label);
}
function Sidebar({
  active = 'home',
  onSelect,
  items = SIDEBAR_ITEMS,
  footerItems = SIDEBAR_FOOTER_ITEMS
}) {
  const rule = {
    height: 1,
    background: '#212B36',
    margin: '0 14px'
  };
  return /*#__PURE__*/React.createElement("nav", {
    style: {
      width: 72,
      height: '100%',
      background: '#0F1822',
      display: 'flex',
      flexDirection: 'column',
      padding: 0,
      border: 0,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '14px 0 10px'
    }
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 130 65",
    style: {
      width: 36,
      height: 18,
      display: 'block'
    },
    "aria-label": "Bicycle"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M46.86 39.61C45.22 42.82 42.55 45.38 39.26 46.89C35.98 48.4 32.28 48.77 28.76 47.93C25.24 47.09 22.11 45.1 19.86 42.28C17.62 39.45 16.4 35.96 16.4 32.36C16.4 28.77 17.62 25.27 19.86 22.45C22.11 19.63 25.24 17.64 28.76 16.8C32.28 15.96 35.98 16.33 39.26 17.84C42.55 19.35 45.22 21.91 46.86 25.12H64.29C62.5 17.37 57.9 10.54 51.37 5.95C44.84 1.35 36.84-0.69 28.89 0.21C20.94 1.1 13.6 4.88 8.27 10.81C2.95 16.74 0 24.41 0 32.36C0 40.32 2.95 47.99 8.27 53.92C13.6 59.85 20.94 63.62 28.89 64.52C36.84 65.42 44.84 63.37 51.37 58.78C57.9 54.18 62.5 47.36 64.29 39.61L46.86 39.61Z",
    fill: "#00C19F"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M81.72 39.61C83.36 42.82 86.04 45.38 89.32 46.89C92.61 48.4 96.31 48.77 99.83 47.93C103.35 47.09 106.48 45.1 108.72 42.28C110.96 39.45 112.18 35.96 112.18 32.36C112.18 28.77 110.96 25.27 108.72 22.45C106.48 19.63 103.35 17.64 99.83 16.8C96.31 15.96 92.61 16.33 89.32 17.84C86.04 19.35 83.36 21.91 81.72 25.12H64.29C66.08 17.37 70.68 10.54 77.21 5.95C83.74 1.35 91.74-0.69 99.69 0.21C107.64 1.1 114.98 4.88 120.31 10.81C125.64 16.74 128.58 24.41 128.58 32.36C128.58 40.32 125.64 47.99 120.31 53.92C114.98 59.85 107.64 63.62 99.69 64.52C91.74 65.42 83.74 63.37 77.21 58.78C70.68 54.18 66.08 47.36 64.29 39.61H81.72Z",
    fill: "#00C19F"
  }))), /*#__PURE__*/React.createElement("div", {
    style: rule
  }), items.map(it => /*#__PURE__*/React.createElement(RailItem, {
    key: it.id,
    item: it,
    active: active === it.id,
    onSelect: onSelect
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: rule
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '10px 0'
    }
  }, footerItems.map(it => /*#__PURE__*/React.createElement(RailItem, {
    key: it.id,
    item: it,
    active: active === it.id,
    onSelect: onSelect
  }))));
}
Object.assign(__ds_scope, { SIDEBAR_ITEMS, SIDEBAR_FOOTER_ITEMS, Sidebar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/Sidebar/Sidebar.jsx", error: String((e && e.message) || e) }); }

// components/Toast/Toast.jsx
try { (() => {
const TONES = {
  success: {
    color: '#3BB443',
    icon: 'circle-check'
  },
  warning: {
    color: '#E6A516',
    icon: 'triangle-exclamation'
  },
  danger: {
    color: '#FF4F36',
    icon: 'circle-exclamation'
  },
  info: {
    color: '#39ACFF',
    icon: 'circle-info'
  }
};
function Toast({
  tone = 'success',
  title,
  sub,
  onClose
}) {
  const t = TONES[tone] || TONES.success;
  const centred = {
    height: 20,
    lineHeight: '20px',
    display: 'inline-flex',
    alignItems: 'center'
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#212B36',
      border: '1px solid #3B444D',
      borderLeft: '3px solid ' + t.color,
      borderRadius: 10,
      padding: '12px 14px',
      display: 'flex',
      gap: 12,
      alignItems: 'flex-start',
      boxShadow: '0 2px 12px rgba(0,0,0,.3)',
      width: 320
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: 'fa-solid fa-' + t.icon,
    style: {
      color: t.color,
      fontSize: 14,
      ...centred
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: '#F4F4F4',
      fontWeight: 500,
      lineHeight: '20px'
    }
  }, title), sub && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: '#B7BCC9',
      lineHeight: '16px',
      marginTop: 2
    }
  }, sub)), /*#__PURE__*/React.createElement("i", {
    className: "fa-solid fa-xmark",
    onClick: onClose,
    style: {
      color: '#8D8F92',
      cursor: 'pointer',
      fontSize: 12,
      ...centred
    }
  }));
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/Toast/Toast.jsx", error: String((e && e.message) || e) }); }

// components/TopNav/TopNav.jsx
try { (() => {
function Mark({
  size = 11,
  color = '#00C19F'
}) {
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 130 65",
    style: {
      width: size * 2,
      height: size,
      display: 'block'
    },
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M46.86 39.61C45.22 42.82 42.55 45.38 39.26 46.89C35.98 48.4 32.28 48.77 28.76 47.93C25.24 47.09 22.11 45.1 19.86 42.28C17.62 39.45 16.4 35.96 16.4 32.36C16.4 28.77 17.62 25.27 19.86 22.45C22.11 19.63 25.24 17.64 28.76 16.8C32.28 15.96 35.98 16.33 39.26 17.84C42.55 19.35 45.22 21.91 46.86 25.12H64.29C62.5 17.37 57.9 10.54 51.37 5.95C44.84 1.35 36.84-0.69 28.89 0.21C20.94 1.1 13.6 4.88 8.27 10.81C2.95 16.74 0 24.41 0 32.36C0 40.32 2.95 47.99 8.27 53.92C13.6 59.85 20.94 63.62 28.89 64.52C36.84 65.42 44.84 63.37 51.37 58.78C57.9 54.18 62.5 47.36 64.29 39.61L46.86 39.61Z",
    fill: color
  }), /*#__PURE__*/React.createElement("path", {
    d: "M81.72 39.61C83.36 42.82 86.04 45.38 89.32 46.89C92.61 48.4 96.31 48.77 99.83 47.93C103.35 47.09 106.48 45.1 108.72 42.28C110.96 39.45 112.18 35.96 112.18 32.36C112.18 28.77 110.96 25.27 108.72 22.45C106.48 19.63 103.35 17.64 99.83 16.8C96.31 15.96 92.61 16.33 89.32 17.84C86.04 19.35 83.36 21.91 81.72 25.12H64.29C66.08 17.37 70.68 10.54 77.21 5.95C83.74 1.35 91.74-0.69 99.69 0.21C107.64 1.1 114.98 4.88 120.31 10.81C125.64 16.74 128.58 24.41 128.58 32.36C128.58 40.32 125.64 47.99 120.31 53.92C114.98 59.85 107.64 63.62 99.69 64.52C91.74 65.42 83.74 63.37 77.21 58.78C70.68 54.18 66.08 47.36 64.29 39.61H81.72Z",
    fill: color
  }));
}
function NavPill({
  children,
  style,
  onClick
}) {
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      background: '#212B36',
      borderRadius: 8,
      height: 36,
      padding: '0 10px',
      cursor: 'pointer',
      fontSize: 14,
      color: '#F4F4F4',
      whiteSpace: 'nowrap',
      ...style
    }
  }, children);
}
function TopNav({
  agentName = 'Use case agent 2',
  label,
  persona = 'Regional Manager, Fleet',
  personaCompact = false,
  workspace = 'Business',
  onAssistant
}) {
  const clip = {
    maxWidth: 180,
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  };
  return /*#__PURE__*/React.createElement("header", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      height: 60,
      padding: '0 16px',
      flexShrink: 0,
      background: '#0F1822',
      borderBottom: '1px solid #212B36'
    }
  }, /*#__PURE__*/React.createElement(NavPill, {
    style: {
      paddingLeft: 8
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "fa-solid fa-house",
    style: {
      color: '#00C19F',
      fontSize: 15
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: clip
  }, agentName), /*#__PURE__*/React.createElement("i", {
    className: "fa-solid fa-share",
    style: {
      color: '#8D8F92',
      fontSize: 12,
      marginLeft: 2
    }
  }), /*#__PURE__*/React.createElement("i", {
    className: "fa-solid fa-chevron-down",
    style: {
      color: '#8D8F92',
      fontSize: 11
    }
  })), label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 16,
      fontWeight: 700
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), persona && (personaCompact ? /*#__PURE__*/React.createElement(NavPill, {
    style: {
      width: 40,
      justifyContent: 'center',
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "fa-solid fa-user",
    style: {
      color: '#B7BCC9'
    }
  })) : /*#__PURE__*/React.createElement(NavPill, {
    style: {
      paddingLeft: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 26,
      height: 26,
      borderRadius: 6,
      background: '#3B444D',
      color: '#B7BCC9',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 12
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "fa-solid fa-user"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      ...clip,
      color: '#B7BCC9'
    }
  }, persona))), workspace && /*#__PURE__*/React.createElement(NavPill, null, /*#__PURE__*/React.createElement("i", {
    className: "fa-solid fa-briefcase",
    style: {
      color: '#8D8F92',
      fontSize: 13
    }
  }), /*#__PURE__*/React.createElement("span", null, workspace)), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      width: 40,
      height: 40,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: onAssistant,
    style: {
      width: 40,
      height: 40,
      borderRadius: 999,
      background: '#212B36',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement(Mark, {
    size: 11
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: 1,
      right: 1,
      width: 9,
      height: 9,
      borderRadius: 999,
      background: '#39ACFF',
      border: '2px solid #0F1822'
    }
  })));
}
Object.assign(__ds_scope, { TopNav });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/TopNav/TopNav.jsx", error: String((e && e.message) || e) }); }

// preview/tweaks-panel.jsx
try { (() => {
// @ds-adherence-ignore -- omelette starter scaffold (raw elements/hex/px by design)

/* BEGIN USAGE */
// tweaks-panel.jsx
// Reusable Tweaks shell + form-control helpers.
// Exports (to window): useTweaks, TweaksPanel, TweakSection, TweakRow, TweakSlider,
//   TweakToggle, TweakRadio, TweakSelect, TweakText, TweakNumber, TweakColor, TweakButton.
//
// Owns the host protocol (listens for __activate_edit_mode / __deactivate_edit_mode,
// posts __edit_mode_available / __edit_mode_set_keys / __edit_mode_dismissed) so
// individual prototypes don't re-roll it. Ships a consistent set of controls so you
// don't hand-draw <input type="range">, segmented radios, steppers, etc.
//
// Usage (in an HTML file that loads React + Babel):
//
//   const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
//     "primaryColor": "#D97757",
//     "palette": ["#D97757", "#29261b", "#f6f4ef"],
//     "fontSize": 16,
//     "density": "regular",
//     "dark": false
//   }/*EDITMODE-END*/;
//
//   function App() {
//     const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
//     return (
//       <div style={{ fontSize: t.fontSize, color: t.primaryColor }}>
//         Hello
//         <TweaksPanel>
//           <TweakSection label="Typography" />
//           <TweakSlider label="Font size" value={t.fontSize} min={10} max={32} unit="px"
//                        onChange={(v) => setTweak('fontSize', v)} />
//           <TweakRadio  label="Density" value={t.density}
//                        options={['compact', 'regular', 'comfy']}
//                        onChange={(v) => setTweak('density', v)} />
//           <TweakSection label="Theme" />
//           <TweakColor  label="Primary" value={t.primaryColor}
//                        options={['#D97757', '#2A6FDB', '#1F8A5B', '#7A5AE0']}
//                        onChange={(v) => setTweak('primaryColor', v)} />
//           <TweakColor  label="Palette" value={t.palette}
//                        options={[['#D97757', '#29261b', '#f6f4ef'],
//                                  ['#475569', '#0f172a', '#f1f5f9']]}
//                        onChange={(v) => setTweak('palette', v)} />
//           <TweakToggle label="Dark mode" value={t.dark}
//                        onChange={(v) => setTweak('dark', v)} />
//         </TweaksPanel>
//       </div>
//     );
//   }
//
// TweakRadio is the segmented control for 2–3 short options (auto-falls-back to
// TweakSelect past ~16/~10 chars per label); reach for TweakSelect directly when
// options are many or long. For color tweaks always curate 3-4 options rather than
// a free picker; an option can also be a whole 2–5 color palette (the stored value
// is the array). The Tweak* controls are a floor, not a ceiling — build custom
// controls inside the panel if a tweak calls for UI they don't cover.
/* END USAGE */
// ─────────────────────────────────────────────────────────────────────────────

const __TWEAKS_STYLE = `
  .twk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:280px;
    max-height:calc(100vh - 32px);display:flex;flex-direction:column;
    transform:scale(var(--dc-inv-zoom,1));transform-origin:bottom right;
    background:rgba(250,249,247,.78);color:#29261b;
    -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);
    border:.5px solid rgba(255,255,255,.6);border-radius:14px;
    box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 12px 40px rgba(0,0,0,.18);
    font:11.5px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden}
  .twk-hd{display:flex;align-items:center;justify-content:space-between;
    padding:10px 8px 10px 14px;cursor:move;user-select:none}
  .twk-hd b{font-size:12px;font-weight:600;letter-spacing:.01em}
  .twk-x{appearance:none;border:0;background:transparent;color:rgba(41,38,27,.55);
    width:22px;height:22px;border-radius:6px;cursor:default;font-size:13px;line-height:1}
  .twk-x:hover{background:rgba(0,0,0,.06);color:#29261b}
  .twk-body{padding:2px 14px 14px;display:flex;flex-direction:column;gap:10px;
    overflow-y:auto;overflow-x:hidden;min-height:0;
    scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.15) transparent}
  .twk-body::-webkit-scrollbar{width:8px}
  .twk-body::-webkit-scrollbar-track{background:transparent;margin:2px}
  .twk-body::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15);border-radius:4px;
    border:2px solid transparent;background-clip:content-box}
  .twk-body::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,.25);
    border:2px solid transparent;background-clip:content-box}
  .twk-row{display:flex;flex-direction:column;gap:5px}
  .twk-row-h{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
  .twk-lbl{display:flex;justify-content:space-between;align-items:baseline;
    color:rgba(41,38,27,.72)}
  .twk-lbl>span:first-child{font-weight:500}
  .twk-val{color:rgba(41,38,27,.5);font-variant-numeric:tabular-nums}

  .twk-sect{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:rgba(41,38,27,.45);padding:10px 0 0}
  .twk-sect:first-child{padding-top:0}

  .twk-field{appearance:none;box-sizing:border-box;width:100%;min-width:0;height:26px;padding:0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;
    background:rgba(255,255,255,.6);color:inherit;font:inherit;outline:none}
  .twk-field:focus{border-color:rgba(0,0,0,.25);background:rgba(255,255,255,.85)}
  select.twk-field{padding-right:22px;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='rgba(0,0,0,.5)' d='M0 0h10L5 6z'/></svg>");
    background-repeat:no-repeat;background-position:right 8px center}

  .twk-slider{appearance:none;-webkit-appearance:none;width:100%;height:4px;margin:6px 0;
    border-radius:999px;background:rgba(0,0,0,.12);outline:none}
  .twk-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;
    width:14px;height:14px;border-radius:50%;background:#fff;
    border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}
  .twk-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;
    background:#fff;border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}

  .twk-seg{position:relative;display:flex;padding:2px;border-radius:8px;
    background:rgba(0,0,0,.06);user-select:none}
  .twk-seg-thumb{position:absolute;top:2px;bottom:2px;border-radius:6px;
    background:rgba(255,255,255,.9);box-shadow:0 1px 2px rgba(0,0,0,.12);
    transition:left .15s cubic-bezier(.3,.7,.4,1),width .15s}
  .twk-seg.dragging .twk-seg-thumb{transition:none}
  .twk-seg button{appearance:none;position:relative;z-index:1;flex:1;border:0;
    background:transparent;color:inherit;font:inherit;font-weight:500;min-height:22px;
    border-radius:6px;cursor:default;padding:4px 6px;line-height:1.2;
    overflow-wrap:anywhere}

  .twk-toggle{position:relative;width:32px;height:18px;border:0;border-radius:999px;
    background:rgba(0,0,0,.15);transition:background .15s;cursor:default;padding:0}
  .twk-toggle[data-on="1"]{background:#34c759}
  .twk-toggle i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
    background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
  .twk-toggle[data-on="1"] i{transform:translateX(14px)}

  .twk-num{display:flex;align-items:center;box-sizing:border-box;min-width:0;height:26px;padding:0 0 0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;background:rgba(255,255,255,.6)}
  .twk-num-lbl{font-weight:500;color:rgba(41,38,27,.6);cursor:ew-resize;
    user-select:none;padding-right:8px}
  .twk-num input{flex:1;min-width:0;height:100%;border:0;background:transparent;
    font:inherit;font-variant-numeric:tabular-nums;text-align:right;padding:0 8px 0 0;
    outline:none;color:inherit;-moz-appearance:textfield}
  .twk-num input::-webkit-inner-spin-button,.twk-num input::-webkit-outer-spin-button{
    -webkit-appearance:none;margin:0}
  .twk-num-unit{padding-right:8px;color:rgba(41,38,27,.45)}

  .twk-btn{appearance:none;height:26px;padding:0 12px;border:0;border-radius:7px;
    background:rgba(0,0,0,.78);color:#fff;font:inherit;font-weight:500;cursor:default}
  .twk-btn:hover{background:rgba(0,0,0,.88)}
  .twk-btn.secondary{background:rgba(0,0,0,.06);color:inherit}
  .twk-btn.secondary:hover{background:rgba(0,0,0,.1)}

  .twk-swatch{appearance:none;-webkit-appearance:none;width:56px;height:22px;
    border:.5px solid rgba(0,0,0,.1);border-radius:6px;padding:0;cursor:default;
    background:transparent;flex-shrink:0}
  .twk-swatch::-webkit-color-swatch-wrapper{padding:0}
  .twk-swatch::-webkit-color-swatch{border:0;border-radius:5.5px}
  .twk-swatch::-moz-color-swatch{border:0;border-radius:5.5px}

  .twk-chips{display:flex;gap:6px}
  .twk-chip{position:relative;appearance:none;flex:1;min-width:0;height:46px;
    padding:0;border:0;border-radius:6px;overflow:hidden;cursor:default;
    box-shadow:0 0 0 .5px rgba(0,0,0,.12),0 1px 2px rgba(0,0,0,.06);
    transition:transform .12s cubic-bezier(.3,.7,.4,1),box-shadow .12s}
  .twk-chip:hover{transform:translateY(-1px);
    box-shadow:0 0 0 .5px rgba(0,0,0,.18),0 4px 10px rgba(0,0,0,.12)}
  .twk-chip[data-on="1"]{box-shadow:0 0 0 1.5px rgba(0,0,0,.85),
    0 2px 6px rgba(0,0,0,.15)}
  .twk-chip>span{position:absolute;top:0;bottom:0;right:0;width:34%;
    display:flex;flex-direction:column;box-shadow:-1px 0 0 rgba(0,0,0,.1)}
  .twk-chip>span>i{flex:1;box-shadow:0 -1px 0 rgba(0,0,0,.1)}
  .twk-chip>span>i:first-child{box-shadow:none}
  .twk-chip svg{position:absolute;top:6px;left:6px;width:13px;height:13px;
    filter:drop-shadow(0 1px 1px rgba(0,0,0,.3))}
`;

// ── useTweaks ───────────────────────────────────────────────────────────────
// Single source of truth for tweak values. setTweak persists via the host
// (__edit_mode_set_keys → host rewrites the EDITMODE block on disk).
function useTweaks(defaults) {
  const [values, setValues] = React.useState(defaults);
  // Accepts either setTweak('key', value) or setTweak({ key: value, ... }) so a
  // useState-style call doesn't write a "[object Object]" key into the persisted
  // JSON block.
  const setTweak = React.useCallback((keyOrEdits, val) => {
    const edits = typeof keyOrEdits === 'object' && keyOrEdits !== null ? keyOrEdits : {
      [keyOrEdits]: val
    };
    setValues(prev => ({
      ...prev,
      ...edits
    }));
    window.parent.postMessage({
      type: '__edit_mode_set_keys',
      edits
    }, '*');
    // Same-window signal so in-page listeners (deck-stage rail thumbnails)
    // can react — the parent message only reaches the host, not peers.
    window.dispatchEvent(new CustomEvent('tweakchange', {
      detail: edits
    }));
  }, []);
  return [values, setTweak];
}

// ── TweaksPanel ─────────────────────────────────────────────────────────────
// Floating shell. Registers the protocol listener BEFORE announcing
// availability — if the announce ran first, the host's activate could land
// before our handler exists and the toolbar toggle would silently no-op.
// The close button posts __edit_mode_dismissed so the host's toolbar toggle
// flips off in lockstep; the host echoes __deactivate_edit_mode back which
// is what actually hides the panel.
function TweaksPanel({
  title = 'Tweaks',
  children
}) {
  const [open, setOpen] = React.useState(false);
  const dragRef = React.useRef(null);
  const offsetRef = React.useRef({
    x: 16,
    y: 16
  });
  const PAD = 16;
  const clampToViewport = React.useCallback(() => {
    const panel = dragRef.current;
    if (!panel) return;
    const w = panel.offsetWidth,
      h = panel.offsetHeight;
    const maxRight = Math.max(PAD, window.innerWidth - w - PAD);
    const maxBottom = Math.max(PAD, window.innerHeight - h - PAD);
    offsetRef.current = {
      x: Math.min(maxRight, Math.max(PAD, offsetRef.current.x)),
      y: Math.min(maxBottom, Math.max(PAD, offsetRef.current.y))
    };
    panel.style.right = offsetRef.current.x + 'px';
    panel.style.bottom = offsetRef.current.y + 'px';
  }, []);
  React.useEffect(() => {
    if (!open) return;
    clampToViewport();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', clampToViewport);
      return () => window.removeEventListener('resize', clampToViewport);
    }
    const ro = new ResizeObserver(clampToViewport);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, [open, clampToViewport]);
  React.useEffect(() => {
    const onMsg = e => {
      const t = e?.data?.type;
      if (t === '__activate_edit_mode') setOpen(true);else if (t === '__deactivate_edit_mode') setOpen(false);
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({
      type: '__edit_mode_available'
    }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);
  const dismiss = () => {
    setOpen(false);
    window.parent.postMessage({
      type: '__edit_mode_dismissed'
    }, '*');
  };
  const onDragStart = e => {
    const panel = dragRef.current;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const sx = e.clientX,
      sy = e.clientY;
    const startRight = window.innerWidth - r.right;
    const startBottom = window.innerHeight - r.bottom;
    const move = ev => {
      offsetRef.current = {
        x: startRight - (ev.clientX - sx),
        y: startBottom - (ev.clientY - sy)
      };
      clampToViewport();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  if (!open) return null;
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("style", null, __TWEAKS_STYLE), /*#__PURE__*/React.createElement("div", {
    ref: dragRef,
    className: "twk-panel",
    "data-omelette-chrome": "",
    style: {
      right: offsetRef.current.x,
      bottom: offsetRef.current.y
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-hd",
    onMouseDown: onDragStart
  }, /*#__PURE__*/React.createElement("b", null, title), /*#__PURE__*/React.createElement("button", {
    className: "twk-x",
    "aria-label": "Close tweaks",
    onMouseDown: e => e.stopPropagation(),
    onClick: dismiss
  }, "\u2715")), /*#__PURE__*/React.createElement("div", {
    className: "twk-body"
  }, children)));
}

// ── Layout helpers ──────────────────────────────────────────────────────────

function TweakSection({
  label,
  children
}) {
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "twk-sect"
  }, label), children);
}
function TweakRow({
  label,
  value,
  children,
  inline = false
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: inline ? 'twk-row twk-row-h' : 'twk-row'
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-lbl"
  }, /*#__PURE__*/React.createElement("span", null, label), value != null && /*#__PURE__*/React.createElement("span", {
    className: "twk-val"
  }, value)), children);
}

// ── Controls ────────────────────────────────────────────────────────────────

function TweakSlider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = '',
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label,
    value: `${value}${unit}`
  }, /*#__PURE__*/React.createElement("input", {
    type: "range",
    className: "twk-slider",
    min: min,
    max: max,
    step: step,
    value: value,
    onChange: e => onChange(Number(e.target.value))
  }));
}
function TweakToggle({
  label,
  value,
  onChange
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "twk-row twk-row-h"
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-lbl"
  }, /*#__PURE__*/React.createElement("span", null, label)), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "twk-toggle",
    "data-on": value ? '1' : '0',
    role: "switch",
    "aria-checked": !!value,
    onClick: () => onChange(!value)
  }, /*#__PURE__*/React.createElement("i", null)));
}
function TweakRadio({
  label,
  value,
  options,
  onChange
}) {
  const trackRef = React.useRef(null);
  const [dragging, setDragging] = React.useState(false);
  // The active value is read by pointer-move handlers attached for the lifetime
  // of a drag — ref it so a stale closure doesn't fire onChange for every move.
  const valueRef = React.useRef(value);
  valueRef.current = value;

  // Segments wrap mid-word once per-segment width runs out. The track is
  // ~248px (280 panel − 28 body pad − 4 seg pad), each button loses 12px
  // to its own padding, and 11.5px system-ui averages ~6.3px/char — so 2
  // options fit ~16 chars each, 3 fit ~10. Past that (or >3 options), fall
  // back to a dropdown rather than wrap.
  const labelLen = o => String(typeof o === 'object' ? o.label : o).length;
  const maxLen = options.reduce((m, o) => Math.max(m, labelLen(o)), 0);
  const fitsAsSegments = maxLen <= ({
    2: 16,
    3: 10
  }[options.length] ?? 0);
  if (!fitsAsSegments) {
    // <select> emits strings — map back to the original option value so the
    // fallback stays type-preserving (numbers, booleans) like the segment path.
    const resolve = s => {
      const m = options.find(o => String(typeof o === 'object' ? o.value : o) === s);
      return m === undefined ? s : typeof m === 'object' ? m.value : m;
    };
    return /*#__PURE__*/React.createElement(TweakSelect, {
      label: label,
      value: value,
      options: options,
      onChange: s => onChange(resolve(s))
    });
  }
  const opts = options.map(o => typeof o === 'object' ? o : {
    value: o,
    label: o
  });
  const idx = Math.max(0, opts.findIndex(o => o.value === value));
  const n = opts.length;
  const segAt = clientX => {
    const r = trackRef.current.getBoundingClientRect();
    const inner = r.width - 4;
    const i = Math.floor((clientX - r.left - 2) / inner * n);
    return opts[Math.max(0, Math.min(n - 1, i))].value;
  };
  const onPointerDown = e => {
    setDragging(true);
    const v0 = segAt(e.clientX);
    if (v0 !== valueRef.current) onChange(v0);
    const move = ev => {
      if (!trackRef.current) return;
      const v = segAt(ev.clientX);
      if (v !== valueRef.current) onChange(v);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("div", {
    ref: trackRef,
    role: "radiogroup",
    onPointerDown: onPointerDown,
    className: dragging ? 'twk-seg dragging' : 'twk-seg'
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-seg-thumb",
    style: {
      left: `calc(2px + ${idx} * (100% - 4px) / ${n})`,
      width: `calc((100% - 4px) / ${n})`
    }
  }), opts.map(o => /*#__PURE__*/React.createElement("button", {
    key: o.value,
    type: "button",
    role: "radio",
    "aria-checked": o.value === value
  }, o.label))));
}
function TweakSelect({
  label,
  value,
  options,
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("select", {
    className: "twk-field",
    value: value,
    onChange: e => onChange(e.target.value)
  }, options.map(o => {
    const v = typeof o === 'object' ? o.value : o;
    const l = typeof o === 'object' ? o.label : o;
    return /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, l);
  })));
}
function TweakText({
  label,
  value,
  placeholder,
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("input", {
    className: "twk-field",
    type: "text",
    value: value,
    placeholder: placeholder,
    onChange: e => onChange(e.target.value)
  }));
}
function TweakNumber({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange
}) {
  const clamp = n => {
    if (min != null && n < min) return min;
    if (max != null && n > max) return max;
    return n;
  };
  const startRef = React.useRef({
    x: 0,
    val: 0
  });
  const onScrubStart = e => {
    e.preventDefault();
    startRef.current = {
      x: e.clientX,
      val: value
    };
    const decimals = (String(step).split('.')[1] || '').length;
    const move = ev => {
      const dx = ev.clientX - startRef.current.x;
      const raw = startRef.current.val + dx * step;
      const snapped = Math.round(raw / step) * step;
      onChange(clamp(Number(snapped.toFixed(decimals))));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "twk-num"
  }, /*#__PURE__*/React.createElement("span", {
    className: "twk-num-lbl",
    onPointerDown: onScrubStart
  }, label), /*#__PURE__*/React.createElement("input", {
    type: "number",
    value: value,
    min: min,
    max: max,
    step: step,
    onChange: e => onChange(clamp(Number(e.target.value)))
  }), unit && /*#__PURE__*/React.createElement("span", {
    className: "twk-num-unit"
  }, unit));
}

// Relative-luminance contrast pick — checkmarks drawn over a swatch need to
// read on both #111 and #fafafa without per-option configuration. Hex input
// only (#rgb / #rrggbb); named or rgb()/hsl() colors fall through to "light".
function __twkIsLight(hex) {
  const h = String(hex).replace('#', '');
  const x = h.length === 3 ? h.replace(/./g, c => c + c) : h.padEnd(6, '0');
  const n = parseInt(x.slice(0, 6), 16);
  if (Number.isNaN(n)) return true;
  const r = n >> 16 & 255,
    g = n >> 8 & 255,
    b = n & 255;
  return r * 299 + g * 587 + b * 114 > 148000;
}
const __TwkCheck = ({
  light
}) => /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 14 14",
  "aria-hidden": "true"
}, /*#__PURE__*/React.createElement("path", {
  d: "M3 7.2 5.8 10 11 4.2",
  fill: "none",
  strokeWidth: "2.2",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  stroke: light ? 'rgba(0,0,0,.78)' : '#fff'
}));

// TweakColor — curated color/palette picker. Each option is either a single
// hex string or an array of 1-5 hex strings; the card adapts — a lone color
// renders solid, a palette renders colors[0] as the hero (left ~2/3) with the
// rest stacked in a sharp column on the right. onChange emits the
// option in the shape it was passed (string stays string, array stays array).
// Without options it falls back to the native color input for back-compat.
function TweakColor({
  label,
  value,
  options,
  onChange
}) {
  if (!options || !options.length) {
    return /*#__PURE__*/React.createElement("div", {
      className: "twk-row twk-row-h"
    }, /*#__PURE__*/React.createElement("div", {
      className: "twk-lbl"
    }, /*#__PURE__*/React.createElement("span", null, label)), /*#__PURE__*/React.createElement("input", {
      type: "color",
      className: "twk-swatch",
      value: value,
      onChange: e => onChange(e.target.value)
    }));
  }
  // Native <input type=color> emits lowercase hex per the HTML spec, so
  // compare case-insensitively. String() guards JSON.stringify(undefined),
  // which returns the primitive undefined (no .toLowerCase).
  const key = o => String(JSON.stringify(o)).toLowerCase();
  const cur = key(value);
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-chips",
    role: "radiogroup"
  }, options.map((o, i) => {
    const colors = Array.isArray(o) ? o : [o];
    const [hero, ...rest] = colors;
    const sup = rest.slice(0, 4);
    const on = key(o) === cur;
    return /*#__PURE__*/React.createElement("button", {
      key: i,
      type: "button",
      className: "twk-chip",
      role: "radio",
      "aria-checked": on,
      "data-on": on ? '1' : '0',
      "aria-label": colors.join(', '),
      title: colors.join(' · '),
      style: {
        background: hero
      },
      onClick: () => onChange(o)
    }, sup.length > 0 && /*#__PURE__*/React.createElement("span", null, sup.map((c, j) => /*#__PURE__*/React.createElement("i", {
      key: j,
      style: {
        background: c
      }
    }))), on && /*#__PURE__*/React.createElement(__TwkCheck, {
      light: __twkIsLight(hero)
    }));
  })));
}
function TweakButton({
  label,
  onClick,
  secondary = false
}) {
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: secondary ? 'twk-btn secondary' : 'twk-btn',
    onClick: onClick
  }, label);
}
Object.assign(window, {
  useTweaks,
  TweaksPanel,
  TweakSection,
  TweakRow,
  TweakSlider,
  TweakToggle,
  TweakRadio,
  TweakSelect,
  TweakText,
  TweakNumber,
  TweakColor,
  TweakButton
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "preview/tweaks-panel.jsx", error: String((e && e.message) || e) }); }

// ui_kits/bicycle-app/App.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// App.jsx — interactive composer for the Bicycle UI kit

const {
  useState
} = React;
const SAMPLE_PROMPTS = ['Revenue by carrier in the last 7 days', 'Top 5 cities with declining bookings this month', 'Why did conversion drop on Tuesday?'];
const ANSWER_ROWS = [{
  city: 'San Francisco',
  carrier: 'Northbound',
  revenue: 248120,
  delta: 4.8
}, {
  city: 'Chicago',
  carrier: 'Midrail',
  revenue: 188004,
  delta: -1.2
}, {
  city: 'Austin',
  carrier: 'Southline',
  revenue: 122560,
  delta: 12.1
}, {
  city: 'New York',
  carrier: 'Eastgate',
  revenue: 312880,
  delta: 2.3
}, {
  city: 'Seattle',
  carrier: 'Pacific',
  revenue: 96302,
  delta: -3.7
}];
const TABLE_COLUMNS = [{
  key: 'city',
  label: 'City'
}, {
  key: 'carrier',
  label: 'Carrier',
  kind: 'muted'
}, {
  key: 'revenue',
  label: 'Revenue',
  kind: 'currency',
  align: 'right'
}, {
  key: 'delta',
  label: 'Δ 7d',
  kind: 'delta',
  align: 'right'
}];
const App = () => {
  const [nav, setNav] = useState('chat');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState('fast');
  const [answered, setAnswered] = useState(false);
  const [toast, setToast] = useState(null);
  const submit = () => {
    if (!prompt.trim()) return;
    setAnswered(true);
    setToast({
      tone: 'success',
      title: 'Query ran in 1.4s',
      sub: `Mode · ${mode}`
    });
    setTimeout(() => setToast(null), 3500);
  };
  const reset = () => {
    setPrompt('');
    setAnswered(false);
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      height: '100vh',
      background: '#0A0F14',
      color: '#F4F4F4',
      fontFamily: "'Outfit',system-ui,sans-serif"
    }
  }, /*#__PURE__*/React.createElement(Sidebar, {
    active: nav,
    onSelect: setNav
  }), /*#__PURE__*/React.createElement("main", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement(TopNav, {
    agentName: "Use case agent 2",
    persona: "Regional Manager, Fleet",
    workspace: "Business",
    onAssistant: () => setNav('chat')
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflow: 'auto',
      padding: 32
    }
  }, nav === 'chat' && /*#__PURE__*/React.createElement(ChatView, {
    prompt: prompt,
    setPrompt: setPrompt,
    mode: mode,
    setMode: setMode,
    submit: submit,
    answered: answered,
    reset: reset
  }), nav === 'home' && /*#__PURE__*/React.createElement(HomeView, {
    onJump: setNav
  }), nav === 'dashboards' && /*#__PURE__*/React.createElement(DataView, null), nav !== 'chat' && nav !== 'home' && nav !== 'dashboards' && /*#__PURE__*/React.createElement(Empty, {
    label: nav
  }))), toast && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      bottom: 24,
      right: 24,
      zIndex: 50
    }
  }, /*#__PURE__*/React.createElement(Toast, _extends({}, toast, {
    onClose: () => setToast(null)
  }))));
};
const ChatView = ({
  prompt,
  setPrompt,
  mode,
  setMode,
  submit,
  answered,
  reset
}) => {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 880,
      margin: '0 auto'
    }
  }, !answered && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center',
      marginTop: 80,
      marginBottom: 28
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 36,
      fontWeight: 600,
      letterSpacing: '-0.02em',
      margin: 0,
      color: '#F4F4F4'
    }
  }, "What do you want to know?"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: '#8D8F92',
      marginTop: 10,
      fontSize: 15
    }
  }, "Ask a question in natural language. Bicycle will query your warehouse and answer.")), answered && /*#__PURE__*/React.createElement(AnswerBlock, {
    prompt: prompt,
    mode: mode,
    onReset: reset
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: answered ? 24 : 0
    }
  }, /*#__PURE__*/React.createElement(AISearchBar, {
    value: prompt,
    onChange: setPrompt,
    mode: mode,
    onModeChange: setMode,
    onSubmit: submit,
    placeholder: "Ask about revenue, churn, operations\u2026"
  })), !answered && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: 14,
      justifyContent: 'center'
    }
  }, SAMPLE_PROMPTS.map(p => /*#__PURE__*/React.createElement("button", {
    key: p,
    onClick: () => setPrompt(p),
    style: {
      background: '#212B36',
      border: '1px solid #2F3842',
      borderRadius: 9999,
      padding: '6px 12px',
      color: '#B7BCC9',
      fontSize: 12,
      cursor: 'pointer',
      fontFamily: 'inherit'
    }
  }, p))));
};
const AnswerBlock = ({
  prompt,
  mode,
  onReset
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    alignItems: 'center',
    gap: 10
  }
}, /*#__PURE__*/React.createElement(Badge, {
  tone: "accent",
  dot: false
}, /*#__PURE__*/React.createElement("i", {
  className: "fa-solid fa-scale-balanced",
  style: {
    fontSize: 10,
    marginRight: 4
  }
}), mode), /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 14,
    color: '#F4F4F4'
  }
}, prompt || '—'), /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1
  }
}), /*#__PURE__*/React.createElement(Button, {
  variant: "text",
  size: "sm",
  icon: "rotate-left",
  onClick: onReset
}, "Reset")), /*#__PURE__*/React.createElement("div", {
  style: {
    background: '#212B36',
    border: '1px solid #2F3842',
    borderRadius: 12,
    padding: 20
  }
}, /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 13,
    color: '#B7BCC9',
    marginBottom: 16
  }
}, "Revenue held steady at ", /*#__PURE__*/React.createElement("span", {
  style: {
    color: '#F4F4F4',
    fontWeight: 500
  }
}, "$967,866"), " over the last 7 days, with", /*#__PURE__*/React.createElement("span", {
  style: {
    color: '#3BB443',
    fontWeight: 500
  }
}, " Austin"), " and", /*#__PURE__*/React.createElement("span", {
  style: {
    color: '#3BB443',
    fontWeight: 500
  }
}, " SF"), " leading growth, while", /*#__PURE__*/React.createElement("span", {
  style: {
    color: '#FF4F36',
    fontWeight: 500
  }
}, " Seattle"), " slipped 3.7%."), /*#__PURE__*/React.createElement(DataTable, {
  columns: TABLE_COLUMNS,
  rows: ANSWER_ROWS
})), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'flex',
    gap: 8
  }
}, /*#__PURE__*/React.createElement(Button, {
  variant: "secondary",
  size: "sm",
  icon: "code"
}, "View SQL"), /*#__PURE__*/React.createElement(Button, {
  variant: "secondary",
  size: "sm",
  icon: "chart-simple"
}, "Plot"), /*#__PURE__*/React.createElement(Button, {
  variant: "secondary",
  size: "sm",
  icon: "share-nodes"
}, "Share"), /*#__PURE__*/React.createElement("div", {
  style: {
    flex: 1
  }
}), /*#__PURE__*/React.createElement(Button, {
  variant: "text",
  size: "sm",
  icon: "thumbs-up"
}, "Helpful"), /*#__PURE__*/React.createElement(Button, {
  variant: "text",
  size: "sm",
  icon: "thumbs-down"
}, "Not quite")));
const ConnectionsView = () => /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
  style: {
    margin: '0 0 18px',
    fontSize: 22,
    fontWeight: 600
  }
}, "Connections"), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))',
    gap: 14
  }
}, /*#__PURE__*/React.createElement(ConnectionCard, {
  name: "prod-warehouse",
  type: "postgres",
  status: "connected",
  rows: "12.4M",
  icon: "database"
}), /*#__PURE__*/React.createElement(ConnectionCard, {
  name: "stripe-events",
  type: "stripe",
  status: "connected",
  rows: "3.1M",
  icon: "credit-card"
}), /*#__PURE__*/React.createElement(ConnectionCard, {
  name: "marketing-bq",
  type: "bigquery",
  status: "stale",
  rows: "892K",
  icon: "cloud"
}), /*#__PURE__*/React.createElement(ConnectionCard, {
  name: "segment-events",
  type: "segment",
  status: "failed",
  rows: "\u2014",
  icon: "code-branch"
}), /*#__PURE__*/React.createElement(ConnectionCard, {
  name: "snowflake-main",
  type: "snowflake",
  status: "connected",
  rows: "47.9M",
  icon: "snowflake"
})));
const HomeView = ({
  onJump
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    maxWidth: 880,
    margin: '0 auto'
  }
}, /*#__PURE__*/React.createElement("h2", {
  style: {
    margin: '0 0 6px',
    fontSize: 24,
    fontWeight: 600
  }
}, "Welcome back, Maya"), /*#__PURE__*/React.createElement("p", {
  style: {
    color: '#8D8F92',
    margin: '0 0 22px'
  }
}, "Pick up where you left off, or ask a new question."), /*#__PURE__*/React.createElement("div", {
  style: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))',
    gap: 14
  }
}, /*#__PURE__*/React.createElement(ConnectionCard, {
  name: "prod-warehouse",
  type: "postgres",
  status: "connected",
  rows: "12.4M",
  icon: "database"
}), /*#__PURE__*/React.createElement(ConnectionCard, {
  name: "stripe-events",
  type: "stripe",
  status: "connected",
  rows: "3.1M",
  icon: "credit-card"
}), /*#__PURE__*/React.createElement(ConnectionCard, {
  name: "marketing-bq",
  type: "bigquery",
  status: "stale",
  rows: "892K",
  icon: "cloud"
}), /*#__PURE__*/React.createElement(ConnectionCard, {
  name: "snowflake-main",
  type: "snowflake",
  status: "connected",
  rows: "47.9M",
  icon: "snowflake"
})), /*#__PURE__*/React.createElement("div", {
  style: {
    marginTop: 22
  }
}, /*#__PURE__*/React.createElement(Button, {
  variant: "primary",
  icon: "sparkles",
  onClick: () => onJump('chat')
}, "Ask a new question")));
const DataView = () => /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
  style: {
    margin: '0 0 18px',
    fontSize: 22,
    fontWeight: 600
  }
}, "Datasets"), /*#__PURE__*/React.createElement(DataTable, {
  columns: TABLE_COLUMNS,
  rows: ANSWER_ROWS
}));
const Empty = ({
  label
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#696D77',
    gap: 10
  }
}, /*#__PURE__*/React.createElement("i", {
  className: "fa-solid fa-cube",
  style: {
    fontSize: 28
  }
}), /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 14
  }
}, "The ", /*#__PURE__*/React.createElement("b", {
  style: {
    color: '#B7BCC9'
  }
}, label), " view is not recreated in this UI kit."));
window.App = App;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/bicycle-app/App.jsx", error: String((e && e.message) || e) }); }

__ds_ns.AISearchBar = __ds_scope.AISearchBar;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.ConnectionCard = __ds_scope.ConnectionCard;

__ds_ns.DataTable = __ds_scope.DataTable;

__ds_ns.MODES = __ds_scope.MODES;

__ds_ns.ModeMenu = __ds_scope.ModeMenu;

__ds_ns.SIDEBAR_ITEMS = __ds_scope.SIDEBAR_ITEMS;

__ds_ns.SIDEBAR_FOOTER_ITEMS = __ds_scope.SIDEBAR_FOOTER_ITEMS;

__ds_ns.Sidebar = __ds_scope.Sidebar;

__ds_ns.Toast = __ds_scope.Toast;

__ds_ns.TopNav = __ds_scope.TopNav;

})();
