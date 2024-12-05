import { writeFile } from 'fs/promises'

import { LuneClient, MonetaryAmount } from '@lune-climate/lune'
import Big from 'big.js'
import { program } from 'commander'
import { stringify } from 'csv-stringify/sync'
import { Err, Ok, Result } from 'ts-results-es'

import { isRunningAsScript, loadCsv as loadCsvUtils } from 'src/utils.js'

program
    .name('lune-simfoni-csv-tool')
    .option('-o, --output <output-csv-file>', 'The destination CSV file containing the results')
    .option(
        '-s, --search-term-columns <search-term-columns>',
        `Comma separated names of the columns containing mapping to the API's 'search_term'`,
    )
    .option(
        '-ca, --category-columns [category-columns]',
        `Comma separated names of the columns containing mapping to the API's 'category'`,
    )
    .option(
        '-m, --monetary-amount-column <monetary-amount-column>',
        `The name of the column containing mapping to the API's 'value'`,
    )
    .option(
        '-cu, --currency-column <currency-column>',
        `The name of the column containing mapping to the API's 'currency'`,
    )
    .option(
        '-c, --country-code-column <country-code-column>',
        `The name of the column containing mapping to the API's 'country_code'`,
    )
    .argument('<csv-file>', 'The source CSV file')

function dashboardUrl(estimateId: string): string {
    return `https://dashboard.lune.co/calculate-emissions/everyday-purchases/${estimateId}/results`
}

async function calculateEmissions(
    luneClient: LuneClient,
    {
        searchTerm,
        category,
        amount,
        currency,
        countryCode,
    }: {
        searchTerm: string
        category?: string
        amount: string
        currency: string
        countryCode: string
    },
): Promise<
    Result<
        {
            emissionsTCo2: string
            emissionFactorName: string
            emissionFactorSource: string
            emissionFactorIntensity: string
            emissionFactorNumeratorUnit: string
            emissionFactorDenominatorUnit: string
            requestedCurrency: string
            exchangeRate: string
            score: number | undefined
            dashboardUrl: string
        },
        string
    >
> {
    const request = {
        value: {
            value: amount,
            currency,
        } as MonetaryAmount,
        merchant: {
            searchTerm,
            countryCode,
            ...(category ? { category } : {}),
        },
    }
    const result = await luneClient.createTransactionEstimate(request)
    if (result.isErr()) {
        return Err(result.error.description)
    }

    if (!('mass' in result.value)) {
        return Ok({
            emissionsTCo2: '',
            emissionFactorName: '',
            emissionFactorSource: '',
            emissionFactorIntensity: '',
            emissionFactorNumeratorUnit: '',
            emissionFactorDenominatorUnit: '',
            requestedCurrency: currency,
            exchangeRate: '',
            score: undefined,
            dashboardUrl: '',
        })
    }

    const exchangeRate = Big(result.value.exchangeRate ?? 1)
    const emissionFactor = result.value.emissionFactor!
    const emissionFactorIntensity = Big(emissionFactor.gasEmissions!.co2E).mul(exchangeRate)

    return Ok({
        emissionsTCo2: result.value.mass.amount,
        emissionFactorName: result.value.emissionFactor!.name,
        emissionFactorSource: result.value.emissionFactor!.source,
        emissionFactorIntensity: emissionFactorIntensity.toString(),
        emissionFactorNumeratorUnit: emissionFactor.numeratorUnit,
        emissionFactorDenominatorUnit: emissionFactor.denominatorUnit,
        requestedCurrency: currency,
        exchangeRate: exchangeRate.toString(),
        score: result.value.searchTermMatchScore,
        dashboardUrl: dashboardUrl(result.value.id),
    })
}

/**
 * Generate all possible permutations of search terms and categories prioritising search terms
 */
function searchCategoryPermutations(
    searchTerms: string[],
    categories: (string | undefined)[],
): { searchTerm: string; category: string | undefined }[] {
    const result = []
    for (const searchTerm of searchTerms) {
        for (const category of categories) {
            result.push({ searchTerm, category })
        }
    }
    return result
}

// eslint-disable-next-line complexity
async function main(): Promise<void> {
    program.parse(process.argv)
    if (program.args.length < 1) {
        program.help()
    }

    const apiKey = process.env.API_KEY
    if (!apiKey) {
        console.error('API_KEY environment variable is required but has not been set.')
        process.exit(1)
    }

    const luneClient = new LuneClient(apiKey)
    const output = program.opts().output
    const {
        searchTermColumns,
        categoryColumns,
        monetaryAmountColumn,
        currencyColumn,
        countryCodeColumn,
    } = program.opts()
    if (!searchTermColumns || !monetaryAmountColumn || !currencyColumn || !countryCodeColumn) {
        console.error(
            'All of search-term-columns, monetary-amount-column, currency-column and country-code-column are required',
        )
        process.exit(1)
    }

    console.log(
        `Warning: this tools assumes: 'monetaryAmountColumn' contains valid floating point numbers, 'currencyColumn' contains valid ISO4217 currency codes and 'countryCodeColumn' valid alpha-3 ISO3166 country codes`,
    )

    const filename = program.args[0]

    const searchTermColumnsArr: readonly string[] = searchTermColumns
        .split(',')
        .map((column: string) => column.trim())
    const categoryColumnsArr: readonly string[] = categoryColumns
        ? categoryColumns.split(',').map((column: string) => column.trim())
        : []

    const columns = [
        ...searchTermColumnsArr,
        monetaryAmountColumn,
        currencyColumn,
        countryCodeColumn,
        ...categoryColumnsArr,
    ]
    const source = await loadCsvUtils(filename, columns)
    if (source.isErr()) {
        console.error(source.error)
        process.exit(1)
    }

    const out: any[] = []
    for (const row of source.value) {
        const searchTerms = searchTermColumnsArr.map((column: string) => row[column].trim())
        const categories = categoryColumnsArr.length
            ? categoryColumnsArr.map((column: string) => row[column].trim())
            : [undefined]
        const amount = row[monetaryAmountColumn].trim().replace(/,/g, '')
        const currency = row[currencyColumn].trim()
        const countryCode = row[countryCodeColumn].trim()

        const searchPermutations = searchCategoryPermutations(searchTerms, categories)

        const permutationsResults: {
            name: string
            emissions: string
            source: string
            url: string
            searchTermUsed: string
            categoryUsed: string
            score: number | null | undefined
            exchangeRate: string
            emissionFactorNumeratorUnit: string
            emissionFactorDenominatorUnit: string
            emissionFactorIntensity: string
            requestedCurrency: string
        }[] = []

        const promises = []
        for (let i = 0; i < searchPermutations.length; i++) {
            // eslint-disable-next-line no-inner-declarations, func-style
            const fn = async () => {
                const { searchTerm, category } = searchPermutations[i]

                const result = await calculateEmissions(luneClient, {
                    searchTerm,
                    category,
                    amount,
                    currency,
                    countryCode,
                })
                if (result.isErr()) {
                    console.error(`Error: ${result.error}`)
                    permutationsResults.push({
                        name: `Error: ${result.error}`,
                        emissions: '',
                        source: '',
                        url: '',
                        searchTermUsed: '',
                        categoryUsed: '',
                        score: null,
                        emissionFactorNumeratorUnit: '',
                        emissionFactorDenominatorUnit: '',
                        emissionFactorIntensity: '',
                        exchangeRate: '',
                        requestedCurrency: '',
                    })
                    return
                }

                const {
                    emissionsTCo2,
                    emissionFactorName,
                    emissionFactorSource,
                    score,
                    dashboardUrl,
                    emissionFactorNumeratorUnit,
                    emissionFactorDenominatorUnit,
                    emissionFactorIntensity,
                    exchangeRate,
                    requestedCurrency,
                } = result.unwrap()

                permutationsResults.push({
                    name: emissionFactorName,
                    emissions: emissionsTCo2,
                    source: emissionFactorSource,
                    url: dashboardUrl,
                    searchTermUsed: searchTerm,
                    categoryUsed: category || '',
                    score,
                    emissionFactorNumeratorUnit,
                    emissionFactorDenominatorUnit,
                    emissionFactorIntensity,
                    exchangeRate,
                    requestedCurrency,
                })
            }
            promises.push(fn())
        }

        await Promise.all(promises)

        const noConfidenceResults = permutationsResults.filter(
            ({ score }) => score === null || score === undefined,
        )
        const withConfidenceResults = permutationsResults.filter(
            ({ score }) => score !== null && score !== undefined,
        )
        const sortedPermutationResults = [
            ...[...withConfidenceResults].sort((a, b) => {
                return a.score! - b.score!
            }),
            ...noConfidenceResults,
        ]

        const resultObj: Record<string, string> = sortedPermutationResults.reduce(
            (acc, result, i) => {
                const idx = i + 1
                const {
                    name,
                    emissions,
                    source,
                    url,
                    searchTermUsed,
                    categoryUsed,
                    score,
                    emissionFactorIntensity,
                    emissionFactorNumeratorUnit,
                    emissionFactorDenominatorUnit,
                    exchangeRate,
                    requestedCurrency,
                } = result
                return {
                    ...acc,
                    [`Emissions (tCO2e) (${idx})`]: emissions,
                    [`Emission factor name (${idx})`]: name,
                    [`Emission factor source (${idx})`]: source,
                    [`Emission factor intensity (${idx})`]: emissionFactorIntensity,
                    [`Emission factor intensity unit (${idx})`]: `${emissionFactorNumeratorUnit}CO2e/${requestedCurrency}`,
                    [`Emission factor original unit (${idx})`]: `${emissionFactorNumeratorUnit}CO2e/${emissionFactorDenominatorUnit}`,
                    [`Exchange rate (${idx})`]: exchangeRate,
                    [`Confidence score (${idx})`]: score ? `${score}` : ``,
                    [`Dashboard URL (${idx})`]: url,
                    [`Search term used (${idx})`]: searchTermUsed,
                    [`Category used (${idx})`]: categoryUsed || ``,
                }
            },
            {},
        )

        out.push({
            ...row,
            ...resultObj,
        })
    }

    const csvText = stringify(out, { header: true, quoted: true })

    if (output) {
        await writeFile(output, csvText)
    } else {
        console.log(csvText)
    }
}

if (isRunningAsScript(import.meta.url)) {
    await main()
}
