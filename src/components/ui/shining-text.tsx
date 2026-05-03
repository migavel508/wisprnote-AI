"use client"

import * as React from "react"

import { motion } from "motion/react";

interface ShiningTextProps {
  text: string;
}

export function ShiningText({ text }: ShiningTextProps) {
  return (
    <motion.h1
      className="bg-[linear-gradient(110deg,#404040,35%,#fff,50%,#404040,75%,#404040)] dark:bg-[linear-gradient(110deg,#71717a,35%,#fafafa,50%,#71717a,75%,#71717a)] bg-[length:200%_100%] bg-clip-text text-base font-regular text-transparent"
      initial={{ backgroundPosition: "200% 0" }}
      animate={{ backgroundPosition: "-200% 0" }}
      transition={{
        repeat: Infinity,
        duration: 2,
        ease: "linear",
      }}
    >
      {text}
    </motion.h1>
  );
}
