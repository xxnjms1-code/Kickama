/**
 * AssetSelector - A searchable, filterable asset/currency selector component.
 * Used throughout the application for selecting trading instruments,
 * currencies, and other financial assets.
 *
 * The component supports keyboard navigation, fuzzy search, grouping by
 * category, and custom rendering of asset items. It can be used as a
 * dropdown, a modal picker, or an inline selector.
 *
 * The fuzzy search uses a simple substring matching algorithm with
 * prefix priority. Results are ranked by:
 *   - Exact symbol match (highest priority)
 *   - Symbol prefix match
 *   - Name substring match
 *   - Symbol substring match
 *   - Category match (lowest priority)
 *
 * TODO: The fuzzy search doesn't handle typos or partial word matches
 * well. A user searching for "Bitcoin" will find it, but "Bitocin"
 * won't match anything. The search should use Levenshtein distance
 * or trigram similarity for typo tolerance. The search improvement
 * was requested by the customer support team after receiving multiple
 * tickets about "the search not working" which were actually typos.
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface Asset {
  id: string;
  symbol: string;
  name: string;
  type: 'crypto' | 'stock' | 'forex' | 'commodity' | 'index' | 'etf';
  exchange?: string;
  currency?: string;
  icon?: string;
  price?: number;
  change24h?: number;
  volume24h?: number;
  marketCap?: number;
  favorite?: boolean;
}

export interface AssetGroup {
  label: string;
  assets: Asset[];
}

export interface AssetSelectorProps {
  assets: Asset[];
  selected: string | null;
  onSelect: (assetId: string) => void;
  onSearch?: (query: string) => void;
  placeholder?: string;
  showFavorites?: boolean;
  showGroups?: boolean;
  showPrices?: boolean;
  showVolume?: boolean;
  showChange?: boolean;
  showIcon?: boolean;
  maxHeight?: number;
  width?: string | number;
  compact?: boolean;
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
  className?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function AssetSelector({
  assets,
  selected,
  onSelect,
  onSearch,
  placeholder = 'Search assets...',
  showFavorites = true,
  showGroups = true,
  showPrices = true,
  showVolume = false,
  showChange = true,
  showIcon = true,
  maxHeight = 400,
  width = 300,
  compact = false,
  disabled = false,
  loading = false,
  error = null,
  className,
}: AssetSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedAsset = useMemo(
    () => assets.find(a => a.id === selected),
    [assets, selected]
  );

  // Filter and search assets
  const { filteredAssets, groups }: { filteredAssets: Asset[]; groups: AssetGroup[] } = useMemo(() => {
    let filtered = [...assets];

    if (showFavoritesOnly) {
      filtered = filtered.filter(a => a.favorite);
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const score = (asset: Asset): number => {
        const symbol = asset.symbol.toLowerCase();
        const name = asset.name.toLowerCase();
        if (symbol === query) return 100;
        if (symbol.startsWith(query)) return 80;
        if (symbol.includes(query)) return 60;
        if (name.startsWith(query)) return 40;
        if (name.includes(query)) return 20;
        return 0;
      };
      filtered.sort((a, b) => score(b) - score(a));
      filtered = filtered.filter(a => score(a) > 0);
    }

    // Group by type
    const grouped: AssetGroup[] = [];
    if (showGroups) {
      const typeOrder = ['crypto', 'stock', 'forex', 'commodity', 'index', 'etf'];
      const typeNames: Record<string, string> = {
        crypto: 'Cryptocurrencies', stock: 'Stocks', forex: 'Forex',
        commodity: 'Commodities', index: 'Indices', etf: 'ETFs',
      };
      for (const type of typeOrder) {
        const typeAssets = filtered.filter(a => a.type === type);
        if (typeAssets.length > 0) {
          grouped.push({ label: typeNames[type] || type, assets: typeAssets });
        }
      }
    }

    return { filteredAssets: filtered, groups: grouped };
  }, [assets, searchQuery, showFavoritesOnly, showGroups]);

  // Flatten for keyboard navigation
  const flatList = useMemo(
    () => groups.length > 0 ? groups.flatMap((g: AssetGroup) => g.assets) : filteredAssets,
    [groups, filteredAssets]
  );

  // Reset highlighted index when search query or favorites filter changes
  useEffect(() => {
    setHighlightedIndex(0);
  }, [searchQuery, showFavoritesOnly]);

  // Trigger search callback when search query changes
  useEffect(() => {
    if (onSearch) {
      onSearch(searchQuery);
    }
  }, [searchQuery, onSearch]);

  // Open/close
  const open = useCallback(() => {
    if (!disabled) {
      setIsOpen(true);
      setSearchQuery('');
      setHighlightedIndex(0);
    }
  }, [disabled]);

  const close = useCallback(() => {
    setIsOpen(false);
    setSearchQuery('');
  }, []);

  const toggle = useCallback(() => {
    if (isOpen) close();
    else open();
  }, [isOpen, open, close]);

  // Selection
  const handleSelect = useCallback((assetId: string) => {
    onSelect(assetId);
    close();
  }, [onSelect, close]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(prev => Math.min(prev + 1, flatList.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex(prev => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (flatList[highlightedIndex]) {
          handleSelect(flatList[highlightedIndex].id);
        }
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
    }
  }, [flatList, highlightedIndex, handleSelect, close]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (isOpen && listRef.current) {
      const items = listRef.current.querySelectorAll('[data-index]');
      if (items[highlightedIndex]) {
        items[highlightedIndex].scrollIntoView({ block: 'nearest' });
      }
    }
  }, [highlightedIndex, isOpen]);

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        close();
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, close]);

  const renderAsset = (asset: Asset, index: number) => {
    const isSelected = asset.id === selected;
    const isHighlighted = index === highlightedIndex;

    return (
      <div
        key={asset.id}
        data-index={index}
        onClick={() => handleSelect(asset.id)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: compact ? 6 : 10,
          padding: compact ? '6px 10px' : '8px 12px',
          cursor: 'pointer',
          background: isSelected
            ? 'rgba(59,130,246,0.15)'
            : isHighlighted
              ? '#1e293b'
              : 'transparent',
          borderRadius: 4,
          transition: 'background 0.1s',
        }}
      >
        {showIcon && (
          <div style={{
            width: compact ? 20 : 24,
            height: compact ? 20 : 24,
            borderRadius: '50%',
            background: asset.type === 'crypto' ? '#f7931a' : '#3b82f6',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: compact ? 10 : 12,
            fontWeight: 700,
            color: '#fff',
            flexShrink: 0,
          }}>
            {asset.symbol.charAt(0)}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: compact ? 12 : 13,
            fontWeight: isSelected ? 700 : 500,
            color: '#f8fafc',
          }}>
            {asset.symbol}
          </div>
          <div style={{
            fontSize: compact ? 10 : 11,
            color: '#64748b',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {asset.name}
          </div>
        </div>
        {showPrices && asset.price != null && (
          <div style={{ textAlign: 'right' }}>
            <div style={{
              fontSize: compact ? 11 : 12,
              fontFamily: 'monospace',
              color: '#e2e8f0',
              fontWeight: 500,
            }}>
              ${asset.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            {showChange && asset.change24h != null && (
              <div style={{
                fontSize: compact ? 9 : 10,
                fontFamily: 'monospace',
                color: asset.change24h >= 0 ? '#22c55e' : '#ef4444',
              }}>
                {asset.change24h >= 0 ? '+' : ''}{asset.change24h.toFixed(2)}%
              </div>
            )}
          </div>
        )}
        {asset.favorite && (
          <span style={{ color: '#eab308', fontSize: 12 }}>★</span>
        )}
      </div>
    );
  };

  return (
    <div ref={dropdownRef} className={className} style={{ position: 'relative', width }}>
      {/* Trigger button */}
      <button
        onClick={toggle}
        disabled={disabled}
        style={{
          width: '100%',
          padding: compact ? '6px 10px' : '8px 12px',
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: disabled ? 'not-allowed' : 'pointer',
          textAlign: 'left',
          fontSize: compact ? 12 : 14,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {selectedAsset ? (
          <>
            {showIcon && (
              <div style={{
                width: compact ? 18 : 22,
                height: compact ? 18 : 22,
                borderRadius: '50%',
                background: selectedAsset.type === 'crypto' ? '#f7931a' : '#3b82f6',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: compact ? 9 : 11,
                fontWeight: 700,
                color: '#fff',
                flexShrink: 0,
              }}>
                {selectedAsset.symbol.charAt(0)}
              </div>
            )}
            <div style={{ flex: 1 }}>
              <span style={{ color: '#f8fafc', fontWeight: 600 }}>{selectedAsset.symbol}</span>
              {!compact && (
                <span style={{ color: '#64748b', marginLeft: 6, fontSize: 12 }}>{selectedAsset.name}</span>
              )}
            </div>
            {showPrices && selectedAsset.price != null && (
              <span style={{ color: '#94a3b8', fontFamily: 'monospace', fontSize: compact ? 11 : 13 }}>
                ${selectedAsset.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            )}
          </>
        ) : (
          <span style={{ color: '#64748b' }}>{placeholder}</span>
        )}
        <span style={{ marginLeft: 'auto', color: '#64748b', fontSize: 10 }}>
          {isOpen ? '▲' : '▼'}
        </span>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          marginTop: 4,
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          zIndex: 1000,
          maxHeight,
          display: 'flex',
          flexDirection: 'column',
        }}>
          {/* Search input */}
          <div style={{ padding: '8px', borderBottom: '1px solid #334155' }}>
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={e => {
                setSearchQuery(e.target.value);
                setHighlightedIndex(0);
                onSearch?.(e.target.value);
              }}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              autoFocus
              style={{
                width: '100%',
                padding: '6px 10px',
                fontSize: compact ? 12 : 13,
                background: '#0f172a',
                border: '1px solid #334155',
                borderRadius: 6,
                color: '#f8fafc',
                outline: 'none',
              }}
            />
          </div>

          {/* Filter toggles */}
          {showFavorites && (
            <div style={{ padding: '4px 8px', borderBottom: '1px solid #1e293b' }}>
              <button
                onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
                style={{
                  padding: '3px 8px',
                  fontSize: 11,
                  border: '1px solid',
                  borderColor: showFavoritesOnly ? '#eab308' : '#334155',
                  borderRadius: 4,
                  background: showFavoritesOnly ? 'rgba(234,179,8,0.15)' : 'transparent',
                  color: showFavoritesOnly ? '#eab308' : '#64748b',
                  cursor: 'pointer',
                }}
              >
                {showFavoritesOnly ? '★ Favorites' : '☆ All'}
              </button>
              <span style={{ color: '#334155', marginLeft: 8, fontSize: 11 }}>
                {filteredAssets.length} assets
              </span>
            </div>
          )}

          {/* Loading / Error / Empty states */}
          {loading && (
            <div style={{ padding: 24, textAlign: 'center', color: '#64748b', fontSize: 12 }}>
              Loading assets...
            </div>
          )}
          {error && (
            <div style={{ padding: 24, textAlign: 'center', color: '#ef4444', fontSize: 12 }}>
              {error}
            </div>
          )}
          {!loading && !error && filteredAssets.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: '#64748b', fontSize: 12 }}>
              {searchQuery ? `No assets matching "${searchQuery}"` : 'No assets available'}
            </div>
          )}

          {/* Asset list */}
          {!loading && !error && filteredAssets.length > 0 && (
            <div
              ref={listRef}
              style={{
                overflowY: 'auto',
                flex: 1,
                padding: '4px',
              }}
            >
              {groups.length > 0 ? (
                groups.map((group: AssetGroup) => (
                  <div key={group.label}>
                    <div style={{
                      padding: '4px 8px',
                      fontSize: 10,
                      color: '#64748b',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}>
                      {group.label}
                    </div>
                    {group.assets.map((asset: Asset, i: number) => {
                      const globalIndex = flatList.indexOf(asset);
                      return renderAsset(asset, globalIndex);
                    })}
                  </div>
                ))
              ) : (
                filteredAssets.map((asset: Asset, i: number) => renderAsset(asset, i))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default AssetSelector;
