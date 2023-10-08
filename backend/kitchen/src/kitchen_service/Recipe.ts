export type RecipeDBType = {
    recipe_id: string
    ingredients: Array<IngredientDBType>
}

export type IngredientDBType = {
    name: string
    qty: number
}