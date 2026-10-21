import { Color } from "@raycast/api";

export interface Fruit {
  id: string;
  name: string;
  color: "Red" | "Yellow" | "Green";
  price: number;
  emoji: string;
  origin: string;
}

export const FRUITS: Fruit[] = [
  { id: "apple", name: "Apple", color: "Red", price: 1.2, emoji: "🍎", origin: "Kazakhstan" },
  { id: "cherry", name: "Cherry", color: "Red", price: 4.5, emoji: "🍒", origin: "Turkey" },
  { id: "strawberry", name: "Strawberry", color: "Red", price: 3.1, emoji: "🍓", origin: "France" },
  { id: "banana", name: "Banana", color: "Yellow", price: 0.5, emoji: "🍌", origin: "Ecuador" },
  { id: "lemon", name: "Lemon", color: "Yellow", price: 0.8, emoji: "🍋", origin: "India" },
  { id: "kiwi", name: "Kiwi", color: "Green", price: 0.9, emoji: "🥝", origin: "China" },
  { id: "pear", name: "Pear", color: "Green", price: 1.4, emoji: "🍐", origin: "Belgium" },
];

export const TINT: Record<Fruit["color"], string> = { Red: Color.Red, Yellow: Color.Yellow, Green: Color.Green };
