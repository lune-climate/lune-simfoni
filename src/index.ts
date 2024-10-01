import { writeFile } from 'fs/promises'

import { LuneClient, MonetaryAmount } from '@lune-climate/lune'
import { program } from 'commander'
import { stringify } from 'csv-stringify/sync'
import { Err, Ok, Result } from 'ts-results-es'

import { isRunningAsScript, loadCsv as loadCsvUtils } from 'src/utils.js'

program
    .name('lune-simfoni-csv-tool')
    .option('-o, --output <output-csv-file>', 'The destination CSV file containing the results')
    .option(
        '-s, --search-term-column <search-term-column>',
        `The name of the column containing mapping to the API's 'search_term'`,
    )
    .option(
        '-ca, --category-column [category-column]',
        `The name of the column containing mapping to the API's 'category'`,
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
        { emissionsTCo2: string; emissionFactorName: string; emissionFactorSource: string },
        string
    >
> {
    const result = await luneClient.createTransactionEstimate({
        value: {
            value: amount,
            currency,
        } as MonetaryAmount,
        merchant: {
            searchTerm,
            countryCode,
            ...(category ? { category } : {}),
        },
    })

    if (result.isErr()) {
        return Err(result.error.description)
    }

    return Ok({
        emissionsTCo2: result.value.mass.amount,
        emissionFactorName: result.value.emissionFactor!.name,
        emissionFactorSource: result.value.emissionFactor!.source,
    })
}

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
        searchTermColumn,
        categoryColumn,
        monetaryAmountColumn,
        currencyColumn,
        countryCodeColumn,
    } = program.opts()
    if (!searchTermColumn || !monetaryAmountColumn || !currencyColumn || !countryCodeColumn) {
        console.error(
            'All of search-term-column, monetary-amount-column, currency-column and country-code-column are required',
        )
        process.exit(1)
    }

    console.log(
        `Warning: this tools assumes: 'monetaryAmountColumn' contains valid floating point numbers, 'currencyColumn' contains valid ISO4217 currency codes and 'countryCodeColumn' valid alpha-3 ISO3166 country codes`,
    )

    const filename = program.args[0]
    const source = await loadCsvUtils(filename, [
        searchTermColumn,
        monetaryAmountColumn,
        currencyColumn,
        countryCodeColumn,
        ...(categoryColumn ? [categoryColumn] : []),
    ])
    if (source.isErr()) {
        console.error(source.error)
        process.exit(1)
    }

    const out: any[] = []
    for (const row of source.value) {
        const searchTerm = row[searchTermColumn].trim()
        const category = categoryColumn ? row[categoryColumn].trim() : undefined
        const amount = row[monetaryAmountColumn].trim()
        const currency = row[currencyColumn].trim()
        const countryCode = row[countryCodeColumn].trim()

        const result = await calculateEmissions(luneClient, {
            searchTerm,
            category,
            amount,
            currency,
            countryCode,
        })
        if (result.isErr()) {
            console.error(`Error: ${result.error}`)
            process.exit(1)
        }

        const { emissionsTCo2, emissionFactorName, emissionFactorSource } = result.value

        out.push({
            ...row,
            'Emissions (tCO2e)': emissionsTCo2,
            'Emission factor name': emissionFactorName,
            'Emission factor source': emissionFactorSource,
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
