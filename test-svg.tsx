import React from 'react';

export const TestSvg = () => {
  return (
    <svg width="800" height="400" viewBox="0 0 300 300" style={{background: 'black'}}>
       {/* 1. Top Right */}
       <path d="M 235 65 L 285 15 L 600 15" stroke="cyan" strokeWidth="2" fill="none" />
       {/* 2. Bottom Right */}
       <path d="M 235 235 L 285 285 L 600 285" stroke="cyan" strokeWidth="2" fill="none" />
       {/* 3. Top Left */}
       <path d="M 65 65 L 15 15 L -300 15" stroke="cyan" strokeWidth="2" fill="none" />
       {/* 4. Bottom Left */}
       <path d="M 65 235 L 15 285 L -300 285" stroke="cyan" strokeWidth="2" fill="none" />
    </svg>
  );
}
