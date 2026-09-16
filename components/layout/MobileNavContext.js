'use client';

import { createContext, useContext, useState } from 'react';

const MobileNavContext = createContext({
  open: false,
  setOpen: () => {},
  collapsed: false,
  setCollapsed: () => {},
});

export function MobileNavProvider({ children }) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <MobileNavContext.Provider value={{ open, setOpen, collapsed, setCollapsed }}>
      {children}
    </MobileNavContext.Provider>
  );
}

export function useMobileNav() {
  return useContext(MobileNavContext);
}

export function useSidebarCollapsed() {
  const { collapsed, setCollapsed } = useContext(MobileNavContext);
  return { collapsed, setCollapsed };
}
